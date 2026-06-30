import type { ScryLink, ScryModel, ScryNode } from './model'
import type {
  ScryerLayer,
  ScryerModelReadResult,
  ScryerReadNodeSummary,
  ScryerRecommendedRead
} from './types'
import {
  childMap,
  descendantIds,
  nodeMap,
  pathForNode,
  summaryForNode
} from './read-selector-model-navigation'
import { nodeNotFound, type SelectorResult } from './read-selector-result'

const SUBTREE_DETAIL_LIMIT_BYTES = 50_000

function pickSourceMap(model: ScryModel, subtreeNodes: ScryNode[], ids: Set<string>) {
  const responsibilityIds = new Set(
    subtreeNodes.flatMap((node) => (node.responsibilities ?? []).map((item) => item.id))
  )
  return Object.fromEntries(
    Object.entries(model.sourceMap).filter(([key]) => ids.has(key) || responsibilityIds.has(key))
  )
}

function pickBoundaries(model: ScryModel, ids: Set<string>) {
  return Object.fromEntries(Object.entries(model.boundaries).filter(([key]) => ids.has(key)))
}

function splitSubtreeLinks(model: ScryModel, ids: Set<string>) {
  const internalLinks: ScryLink[] = []
  const externalLinks: ScryLink[] = []
  for (const link of model.links) {
    const srcInside = ids.has(link.src)
    const dstInside = ids.has(link.dst)
    if (srcInside && dstInside) {
      internalLinks.push(link)
    } else if (srcInside || dstInside) {
      externalLinks.push(link)
    }
  }
  return { internalLinks, externalLinks }
}

function contextNodesForLinks(
  links: ScryLink[],
  ids: Set<string>,
  model: ScryModel,
  nodes: Map<string, ScryNode>
): ScryerReadNodeSummary[] {
  const contextIds = new Set<string>()
  for (const link of links) {
    if (!ids.has(link.src)) {
      contextIds.add(link.src)
    }
    if (!ids.has(link.dst)) {
      contextIds.add(link.dst)
    }
  }
  return [...contextIds]
    .map((id) => nodes.get(id))
    .filter((node): node is ScryNode => Boolean(node))
    .map((node) => summaryForNode(node, model, nodes))
}

function referencesForChildren(rootId: string, model: ScryModel, nodes: Map<string, ScryNode>) {
  return model.links.flatMap((link) => {
    const reference =
      link.src === rootId
        ? { id: link.dst, direction: 'outgoing' as const }
        : link.dst === rootId
          ? { id: link.src, direction: 'incoming' as const }
          : null
    if (!reference) {
      return []
    }
    const node = nodes.get(reference.id)
    if (!node) {
      return []
    }
    return [
      {
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: pathForNode(node, nodes),
        direction: reference.direction,
        label: link.label
      }
    ]
  })
}

function recommendedForSubtree(
  node: ScryNode,
  contextNodes: ScryerReadNodeSummary[],
  layer: ScryerLayer,
  children: ScryerReadNodeSummary[] = []
): ScryerRecommendedRead[] {
  return [
    ...children.slice(0, 5).map((child) => ({
      operationId: 'scryer.model.read' as const,
      input: { view: 'subtree', node: child.id, layer },
      reason: `Drill into ${child.name}.`
    })),
    ...contextNodes.slice(0, 5).map((context) => ({
      operationId: 'scryer.model.read' as const,
      input: { view: 'subtree', node: context.id, layer },
      reason: `Read linked context node ${context.name}.`
    })),
    {
      operationId: 'scryer.model.search',
      input: { query: node.name, layer },
      reason: 'Search related model concepts by text.'
    }
  ]
}

export function selectSubtree(
  model: ScryModel,
  layer: ScryerLayer,
  nodeId: string
): SelectorResult<ScryerModelReadResult> {
  const nodes = nodeMap(model)
  const root = nodes.get(nodeId)
  if (!root) {
    return nodeNotFound(nodeId)
  }
  const children = childMap(model)
  const ids = descendantIds(nodeId, children)
  const subtreeNodes = model.nodes.filter((node) => ids.has(node.id))
  const descendants = subtreeNodes.filter((node) => node.id !== nodeId)
  const { internalLinks, externalLinks } = splitSubtreeLinks(model, ids)
  const contextNodes = contextNodesForLinks(externalLinks, ids, model, nodes)
  const base = {
    view: 'subtree' as const,
    layer,
    version: model.version,
    nodeCount: model.nodes.length,
    linkCount: model.links.length,
    groupCount: model.groups.length,
    node: summaryForNode(root, model, nodes),
    internalLinks,
    externalLinks,
    contextNodes,
    referencesForChildren: referencesForChildren(nodeId, model, nodes),
    sourceMap: pickSourceMap(model, subtreeNodes, ids),
    boundaries: pickBoundaries(model, ids)
  }
  const estimated = JSON.stringify({ ...base, descendants }).length
  if (estimated > SUBTREE_DETAIL_LIMIT_BYTES) {
    const directChildren = (children.get(nodeId) ?? []).map((child) =>
      summaryForNode(child, model, nodes)
    )
    return {
      ok: true,
      result: {
        ...base,
        descendants: [],
        internalLinks: [],
        sourceMap: {},
        boundaries: {},
        degraded: true,
        truncated: true,
        approximateSizeBytes: estimated,
        children: directChildren,
        recommendedNextReads: recommendedForSubtree(root, contextNodes, layer, directChildren)
      }
    }
  }
  return {
    ok: true,
    result: {
      ...base,
      descendants,
      degraded: false,
      truncated: false,
      recommendedNextReads: recommendedForSubtree(root, contextNodes, layer)
    }
  }
}
