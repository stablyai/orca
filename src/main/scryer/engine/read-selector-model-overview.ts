import type { ScryModel, ScryNode } from './model'
import type {
  ScryerLayer,
  ScryerModelReadResult,
  ScryerReadOverviewNode,
  ScryerRecommendedRead
} from './types'
import {
  childCounts,
  childMap,
  nodeMap,
  summaryForNode
} from './read-selector-model-navigation'

function sourceAnchored(node: ScryNode, model: ScryModel): boolean {
  if (model.sourceMap[node.id]?.length) {
    return true
  }
  return (node.responsibilities ?? []).some((responsibility) =>
    Boolean(model.sourceMap[responsibility.id]?.length)
  )
}

function groupCounts(model: ScryModel): Map<string, number> {
  const counts = new Map<string, number>()
  for (const group of model.groups) {
    for (const memberId of group.memberIds) {
      counts.set(memberId, (counts.get(memberId) ?? 0) + 1)
    }
  }
  return counts
}

function hasExternalLinks(node: ScryNode, model: ScryModel): boolean {
  return model.links.some((link) => link.src === node.id || link.dst === node.id)
}

function hasSymbolDescendant(node: ScryNode, children: Map<string, ScryNode[]>): boolean {
  const pending = [...(children.get(node.id) ?? [])]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.kind === 'symbol') {
      return true
    }
    pending.push(...(children.get(current.id) ?? []))
  }
  return false
}

function overviewForNode(
  node: ScryNode,
  model: ScryModel,
  nodes: Map<string, ScryNode>,
  children: Map<string, ScryNode[]>,
  counts: Map<string, number>,
  groups: Map<string, number>
): ScryerReadOverviewNode {
  const summary = summaryForNode(node, model, nodes, counts)
  const directChildren = children.get(node.id) ?? []
  return {
    id: summary.id,
    kind: summary.kind,
    name: summary.name,
    path: summary.path,
    depth: summary.depth,
    childCount: summary.childCount,
    directSymbolCount: directChildren.filter((child) => child.kind === 'symbol').length,
    responsibilityCount: node.responsibilities?.length ?? 0,
    propertyCount: node.properties?.length ?? 0,
    groupCount: groups.get(node.id) ?? 0,
    hasSourceAnchors: sourceAnchored(node, model),
    hasBoundaries: Boolean(model.boundaries[node.id]?.length),
    hasExternalLinks: hasExternalLinks(node, model),
    hiddenSymbolDescendants: hasSymbolDescendant(node, children),
    hasChildren: summary.childCount > 0,
    ...(summary.parentId ? { parentId: summary.parentId } : {}),
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.technology ? { technology: summary.technology } : {}),
    ...(summary.external !== undefined ? { external: summary.external } : {}),
    ...(summary.stale !== undefined ? { stale: summary.stale } : {}),
    ...(summary.vagrant !== undefined ? { vagrant: summary.vagrant } : {})
  }
}

function recommendedForOverview(model: ScryModel, layer: ScryerLayer): ScryerRecommendedRead[] {
  const firstDrillTarget = model.nodes.find((node) => node.kind !== 'symbol')
  return [
    ...(firstDrillTarget
      ? [
          {
            operationId: 'scryer.model.read' as const,
            input: { view: 'subtree', node: firstDrillTarget.id, layer },
            reason: 'Drill into a visible overview node for responsibilities, links, and sources.'
          }
        ]
      : []),
    {
      operationId: 'scryer.model.search',
      input: { query: '<text>', layer },
      reason: 'Locate a concept when the node id is unknown.'
    },
    {
      operationId: 'scryer.model.query',
      input: { where: [{ field: 'kind', op: 'eq', value: 'component' }], layer },
      reason: 'Find model nodes by structural shape.'
    },
    {
      operationId: 'scryer.model.read',
      input: { view: 'full', layer },
      reason: 'Use explicit full reads only for export, debug, fixtures, or broad restructuring.'
    }
  ]
}

export function selectOverview(model: ScryModel, layer: ScryerLayer): ScryerModelReadResult {
  const nodes = nodeMap(model)
  const children = childMap(model)
  const counts = childCounts(model)
  const groups = groupCounts(model)
  return {
    view: 'overview',
    layer,
    version: model.version,
    nodeCount: model.nodes.length,
    linkCount: model.links.length,
    groupCount: model.groups.length,
    truncated: false,
    overview: model.nodes
      .filter((node) => node.kind !== 'symbol')
      .map((node) => overviewForNode(node, model, nodes, children, counts, groups)),
    recommendedNextReads: recommendedForOverview(model, layer)
  }
}
