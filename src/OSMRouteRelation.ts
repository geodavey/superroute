import type { OSMRelationMember } from "./OSMRelation";
import type { OverpassRelation } from "overpass-ts";

import OSMSuperRouteRelation from "./OSMSuperRouteRelation";
import OSMRelation from "./OSMRelation";
import turfLength from "@turf/length";
import OSMWay from "./OSMWay";

import { _isReversed, _absoluteId, reverseLineFeature } from "./utils";

type RouteStatistics = {
  numSegments: number;
  numNodes: number;
  length: number;
  surfacePct: number;
  surfaceWays: string[];
  sacScalePct: number;
  sacScaleWays: string[];

  ascent?: number;
  descent?: number;
};

type RouteGraph = Map<string, Map<string, string>>;
type WayLikeMember = OSMWay | OSMRouteRelation | OSMSuperRouteRelation;

export default class OSMRouteRelation extends OSMRelation {
  _orderedChildIds: string[];
  _routeGraph: RouteGraph;
  _statistics: RouteStatistics;
  _isRoutable: boolean;

  constructor(relation: OverpassRelation) {
    super(relation);
  }

  /**
   * Build a graph from an array of members, using relation/way ID as
   * edge ID and node ID as node ID
   * Will error if any members are not routable
   */
  _buildRouteGraph(members: OSMRelationMember[]): RouteGraph {
    // routeGraph:
    // {
    //   endNodeId: {
    //       otherEndNodeId: edgeId;
    //   }
    // }
    // ** edgeId is way or waylike route relation
    // ** edgeId is negative if it is reversed

    const routeGraph = new Map();
    const errors = [];

    for (const member of members) {
      try {
        if (member.type === "node") continue;

        const connectionEl = member.element as WayLikeMember;
        const endIds = connectionEl.endNodes;
        const endPairs = [
          [endIds[0], endIds[1], ""],
          [endIds[1], endIds[0], "-"],
        ];

        for (const endPair of endPairs) {
          if (!routeGraph.has(endPair[0]))
            routeGraph.set(
              endPair[0],
              new Map([[endPair[1], `${endPair[2]}${connectionEl.id}`]])
            );
          else {
            routeGraph
              .get(endPair[0])
              .set(endPair[1], `${endPair[2]}${connectionEl.id}`);
          }
        }
      } catch (e) {
        errors.push(e);
      }
    }

    if (errors.length > 0) throw new SuperRouteTopologyError(this, errors);

    return routeGraph;
  }

  /**
   * Node IDs of end nodes
   */
  get endNodes(): string[] {
    if (this.isRoutable) {
      const nodeDegrees = this.nodeDegrees;

      // if is roundtrip, return first 2nd degree node as start & end
      // if is one way, return pair of 1st degree nodes

      return nodeDegrees[1].length === 0
        ? [nodeDegrees[2][0], nodeDegrees[2][0]]
        : [nodeDegrees[1][0], nodeDegrees[1][1]];
    } else throw new RouteTopologyError(this);
  }

  /**
   * 2D array of RouteGraph nodes binned by node degree
   * ex. nodeDegrees[1]: array of node IDs with degree 1
   */
  get nodeDegrees(): string[][] {
    //         degrees:  0   1   2   3+
    const nodeDegrees = [[], [], [], []];

    this.routeGraph.forEach((edgesIds, endId) => {
      nodeDegrees[Math.min(edgesIds.size, 3)].push(endId);
    });

    return nodeDegrees;
  }

  /**
   * If RouteRelation is routable (can be represented as single LineString)
   */
  get isRoutable(): boolean {
    if (typeof this._isRoutable !== "undefined") return this._isRoutable;

    try {
      const nodeDegrees = this.nodeDegrees;

      const hasNo3PlusDegreeNodes = nodeDegrees[3].length === 0;
      const isRoundTrip = nodeDegrees[1].length < 2;
      const isOneWay = nodeDegrees[1].length === 2;

      this._isRoutable = hasNo3PlusDegreeNodes && (isRoundTrip || isOneWay);
    } catch (e) {
      this._isRoutable = false;
    }

    return this._isRoutable;
  }

  /**
   * OSMRouteRelation children: ways
   */
  get children(): OSMRelationMember[] {
    return this.members.filter(
      (member) => member.type === "way" && "element" in member
    );
  }

  get alternatives(): GeoJSON.FeatureCollection {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: [
              ...this.children
                .filter((child) => child.role === "alternative")
                .map((child) => (child.element as OSMWay).lineStringFeature)
                .map((feat) => feat.geometry.coordinates),
            ],
          },
        },
      ],
    };
  }

  /**
   * Cache routeGraph whenever it is calculated
   * Calculate routeGraph with only main route (omit alternative routes)
   */
  get routeGraph(): RouteGraph {
    if (typeof this._routeGraph !== "undefined") return this._routeGraph;

    this._routeGraph = this._buildRouteGraph(
      this.children.filter((m) => m.role !== "alternative")
    );

    return this._routeGraph;
  }

  /**
   * Calculate sequence of ordered member IDs and cache result
   *
   * Ordered member IDs are calculated by:
   *
   *  (for end-to-end routes)
   *   * start from the first-degree node of the first member with a
   *     first-degree node in it, and route to other end
   *
   *  (for round-trip routes)
   *   * start from first node of first member encountered in relation
   *     and route all the way around
   */
  get orderedChildIds(): string[] {
    if (!this.isRoutable) throw new RouteTopologyError(this);

    if (typeof this._orderedChildIds !== "undefined")
      return this._orderedChildIds;

    // if is single member return just that member ID
    if (this.routeGraph.size === 1) {
      return [
        this.routeGraph.entries().next().value[1].entries().next().value[1],
      ];
    }

    const orderedChildren = [];

    let lastId = "-1",
      currId = "-1",
      nextId = "-1",
      endId = "-1";

    // find the next node by identifying neighbor node that has a different
    // id than the id of the previous node
    const _getNextNode = (currId, lastId) =>
      Array.from(this.routeGraph.get(currId).keys()).filter(
        (k) => k != lastId
      )[0];

    // if is one-way
    // find route start node by selecting the first end node with degree=1
    for (const [nodeId, neighborIds] of this.routeGraph) {
      if (neighborIds.size == 1) {
        currId = nodeId;
        nextId = _getNextNode(currId, lastId);

        break;
      }
    }

    // if is round-trip
    if (currId === "-1") {
      const firstNodeMap = this.routeGraph.entries().next().value;
      const adjacentMap = firstNodeMap[1].entries().next().value;

      currId = firstNodeMap[0];
      nextId = adjacentMap[0];
      endId = firstNodeMap[0];
    }

    while (typeof nextId !== "undefined") {
      const nextMemberId = this.routeGraph.get(currId).get(nextId);
      orderedChildren.push(nextMemberId);

      lastId = currId;
      currId = nextId;
      nextId = _getNextNode(currId, lastId);

      // break off a round-trip when end reached
      if (currId === endId && lastId !== "-1") break;
    }

    this._orderedChildIds = orderedChildren;
    return this._orderedChildIds;
  }

  //
  // GeoJSON Features
  //

  /**
   * Get ordered GeoJSON FeatureCollection of all relation children
   */
  get orderedFeatureCollection(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    if (!this.isRoutable) throw new RouteTopologyError(this);

    const childrenMap = new Map(
      this.children.map((child) => {
        return [child.element.id, child];
      })
    );

    const featCollection = this.orderedChildIds.map((childId) => {
      return _isReversed(childId)
        ? reverseLineFeature(
            (childrenMap.get(_absoluteId(childId)).element as WayLikeMember)
              .lineStringFeature
          )
        : (childrenMap.get(childId).element as WayLikeMember).lineStringFeature;
    });

    return {
      type: "FeatureCollection",
      features: featCollection as GeoJSON.Feature<GeoJSON.LineString>[],
    };
  }

  get deepOrderedFeatureCollection(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    return this.orderedFeatureCollection;
  }

  /**
   * Return a GeoJSON FeatureCollection of all route children
   */
  get featureCollection(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    return {
      type: "FeatureCollection",
      features: this.children
        .filter((child) => child.role !== "alternative")
        .map((child) => (child.element as WayLikeMember).lineStringFeature),
    };
  }

  get deepFeatureCollection(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    return this.featureCollection;
  }

  /**
   * Return route as a single LineString feature, if is routable
   * Will error if LineString not routable
   */
  get lineStringFeature(): GeoJSON.Feature<GeoJSON.LineString> {
    const ordered = this.orderedFeatureCollection;

    const firstCoordinates = ordered.features.shift().geometry["coordinates"];
    const otherCoordinates = ordered.features.map((feat) =>
      feat.geometry["coordinates"].slice(1)
    );

    return {
      type: "Feature",
      properties: this.properties,
      geometry: {
        type: "LineString",
        coordinates: firstCoordinates.concat(...otherCoordinates),
      },
    };
  }

  /**
   * Return route as multi
   */
  get multiLineStringFeature(): GeoJSON.Feature<GeoJSON.MultiLineString> {
    return {
      type: "Feature",
      properties: this.properties,
      geometry: {
        type: "MultiLineString",
        coordinates: (this.featureCollection
          .features as GeoJSON.Feature<GeoJSON.LineString>[]).map(
          (feat) => feat.geometry.coordinates
        ),
      },
    };
  }

  get deepMultiLineStringFeature(): GeoJSON.Feature<GeoJSON.MultiLineString> {
    return this.multiLineStringFeature;
  }

  /**
   * Return a LineString if is routable, otherwise MultiLineString
   */
  get simplestFeature(): GeoJSON.Feature<
    GeoJSON.MultiLineString | GeoJSON.LineString
  > {
    return this.isRoutable
      ? this.lineStringFeature
      : this.deepMultiLineStringFeature;
  }

  get statistics(): RouteStatistics {
    if (typeof this._statistics !== "undefined") return this._statistics;

    const deepFeatureCollection = this.deepFeatureCollection;

    const statistics = {
      numSegments: 0,
      numNodes: 0,
      surfacePct: 0,
      surfaceWays: [],
      sacScalePct: 0,
      sacScaleWays: [],
      length: 0,
    };

    let numSacScaleRelevant = 0;
    let numSacScale = 0;

    deepFeatureCollection.features.forEach((segment) => {
      // numSegments numNodes
      statistics["numSegments"] += 1;
      statistics["numNodes"] += segment.geometry.coordinates.length;

      // surface=* stats
      if ("surface" in segment.properties)
        statistics.surfacePct += 1 / statistics.numSegments;
      else statistics.surfaceWays.push(segment.properties["@id"]);

      // sac_scale=* stats
      // only include path track and footway in calculations
      if (
        "highway" in segment.properties &&
        ["path", "track", "footway"].includes(segment.properties.highway)
      ) {
        numSacScaleRelevant += 1;

        if ("sac_scale" in segment.properties) numSacScale += 1;
        else statistics.sacScaleWays.push(segment.properties["@id"]);
      }

      // length
      statistics.length += turfLength(segment) * 1000;
    });

    statistics["sacScalePct"] = numSacScale / numSacScaleRelevant;

    // calculate ascent/descent if route is routable and 3d
    if (this.isRoutable) {
      const lineStringCoords = this.lineStringFeature.geometry.coordinates;

      if (lineStringCoords[0].length === 3) {
        statistics["ascent"] = 0;
        statistics["descent"] = 0;

        lineStringCoords.forEach((coord, coordIdx) => {
          if (coordIdx !== 0) {
            const lastCoord = lineStringCoords[coordIdx - 1];

            // elevation gain
            if (coord[2] > lastCoord[2])
              statistics["ascent"] += coord[2] - lastCoord[2];
            else if (coord[2] < lastCoord[2])
              statistics["descent"] += lastCoord[2] - coord[2];
          }
        });
      }
    }
    const round = (number) => Math.round(number * 100) / 100

    statistics["surfacePct"] = round(statistics["surfacePct"]) * 100;
    statistics["sacScalePct"] = round(statistics["sacScalePct"]) * 100;
    statistics["length"] = round(statistics["length"]);
    statistics["ascent"] = round(statistics["ascent"]);
    statistics["descent"] = round(statistics["descent"]);

    this._statistics = statistics;
    return this._statistics;
  }
}

export class RouteTopologyError extends Error {
  errNodes: number[];
  route: OSMRouteRelation;

  constructor(route: OSMRouteRelation | OSMSuperRouteRelation) {
    const nodeDegrees = route.nodeDegrees;
    const errNodes = [];
    const err = [];

    if (nodeDegrees[3].length > 0) {
      nodeDegrees[3].forEach((id_) => {
        errNodes.push(id_);
      });
      err.push(`${nodeDegrees[3].length} node > 2deg`);
    }

    if (nodeDegrees[1].length > 2) {
      nodeDegrees[1].forEach((id_) => {
        errNodes.push(id_);
      });
      err.push(`${nodeDegrees[1].length} dead end`);
    }

    super(
      `${route.id} (${route.tags["name"]}) is not routable: ${err.join(",")}`
    );

    this.route = route;
    this.errNodes = errNodes;
  }
}

export class SuperRouteTopologyError extends Error {
  route: OSMRouteRelation;
  errors: RouteTopologyError[];

  constructor(route: OSMRouteRelation, errors: RouteTopologyError[]) {
    const subErrorMessages = errors.map((err) =>
      err.message.split("\n").join("\n  ")
    );

    const errLines = [
      `${route.id} (${route.tags["name"]}) is not routable`,
      ...subErrorMessages,
    ];

    super(errLines.join("\n  "));

    this.route = route;
    this.errors = errors;
  }
}
