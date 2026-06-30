import type { ScryModel, ScryNode } from './model'
import type { ScryerReadNodeSummary } from './types'

export function nodeMap(model: ScryModel): Map<string, ScryNode> {
  return new Map(model.nodes.map((node) => [node.id, node]))
}

export function childMap(model: ScryModel): Map<string, ScryNode[]> {
  const children = new Map<string, ScryNode[]>()
  for (const node of model.nodes) {
    if (!node.parentId) {
      continue
    }
    const list = children.get(node.parentId) ?? []
    list.push(node)
    children.set(node.parentId, list)
  }
  return children
}

export function childCounts(model: ScryModel): Map<string, number> {
  const counts = new Map<string, number>()
  for (const node of model.nodes) {
    if (node.parentId) {
      counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1)
    }
  }
  return counts
}

export function pathForNode(node: ScryNode, nodes: Map<string, ScryNode>): string {
  const names = [node.name]
  let current = node.parentId ? nodes.get(node.parentId) : undefined
  while (current) {
    names.unshift(current.name)
    current = current.parentId ? nodes.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

export function depthForPath(path: string): number {
  return Math.max(path.split(' / ').length - 1, 0)
}

export function summaryForNode(
  node: ScryNode,
  model: ScryModel,
  nodes: Map<string, ScryNode>,
  counts = childCounts(model)
): ScryerReadNodeSummary {
  const path = pathForNode(node, nodes)
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    path,
    depth: depthForPath(path),
    childCount: counts.get(node.id) ?? 0,
    nResp: node.responsibilities?.length ?? 0,
    nProps: node.properties?.length ?? 0,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.technology ? { technology: node.technology } : {}),
    ...(node.external !== undefined ? { external: node.external } : {}),
    ...(node.stale !== undefined ? { stale: node.stale } : {}),
    ...(node.vagrant !== undefined ? { vagrant: node.vagrant } : {})
  }
}

export function descendantIds(rootId: string, children: Map<string, ScryNode[]>): Set<string> {
  const ids = new Set<string>([rootId])
  const pending = [rootId]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const child of children.get(current) ?? []) {
      if (!ids.has(child.id)) {
        ids.add(child.id)
        pending.push(child.id)
      }
    }
  }
  return ids
}
