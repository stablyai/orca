import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import {
  appendTabGroupLayout,
  collectLayoutGroupIds
} from '../../../../shared/workspace-layout/tab-group-layout-composition'
import { pruneGroupLayout } from '../../../../shared/workspace-session/workspace-session-terminal-tab-close'

type IndexedNode = { depth: number; parents: number[] }
type Graft = {
  branch: Extract<TabGroupLayoutNode, { type: 'split' }>
  missing: TabGroupLayoutNode
  anchorFirst: boolean
}

function keepGroups(
  root: TabGroupLayoutNode | undefined,
  ids: ReadonlySet<string>
): TabGroupLayoutNode | null {
  return [...collectLayoutGroupIds(root)].every((id) => ids.has(id))
    ? (root ?? null)
    : (pruneGroupLayout(root, ids) ?? null)
}

/** Batch prior sibling grafts so missing groups never each rescan the incoming tree. */
export function rebaseTerminalGroupLayout(
  candidate: TabGroupLayoutNode | undefined,
  current: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>,
  requiredGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  const incoming = keepGroups(candidate, validGroupIds)
  const incomingIds = collectLayoutGroupIds(incoming ?? undefined)
  const missing = new Set([...requiredGroupIds].filter((id) => !incomingIds.has(id)))
  if (missing.size === 0) {
    return incoming
  }
  const prior = keepGroups(current, new Set([...incomingIds, ...missing]))
  if (!prior || !incoming) {
    return prior ?? incoming
  }
  const nodes: IndexedNode[] = []
  const indexByNode = new Map<TabGroupLayoutNode, number>()
  const indexByGroup = new Map<string, number>()
  const index = (node: TabGroupLayoutNode, parent?: number): void => {
    const parents = parent === undefined ? [] : [parent]
    for (let level = 1; parents[level - 1] !== undefined; level++) {
      const ancestor = nodes[parents[level - 1]!]!.parents[level - 1]
      if (ancestor === undefined) {
        break
      }
      parents.push(ancestor)
    }
    const id = nodes.length
    nodes.push({ parents, depth: parent === undefined ? 0 : nodes[parent]!.depth + 1 })
    indexByNode.set(node, id)
    if (node.type === 'leaf') {
      indexByGroup.set(node.groupId, id)
    } else {
      index(node.first, id)
      index(node.second, id)
    }
  }
  index(incoming)
  const commonAncestor = (left: number, right: number): number => {
    let a = nodes[left]!.depth >= nodes[right]!.depth ? left : right
    let b = a === left ? right : left
    for (let level = nodes[a]!.parents.length - 1; level >= 0; level--) {
      const parent = nodes[a]!.parents[level]
      if (parent !== undefined && nodes[parent]!.depth >= nodes[b]!.depth) {
        a = parent
      }
    }
    if (a === b) {
      return a
    }
    for (let level = nodes[a]!.parents.length - 1; level >= 0; level--) {
      const pa = nodes[a]!.parents[level]
      const pb = nodes[b]!.parents[level]
      if (pa !== undefined && pb !== undefined && pa !== pb) {
        a = pa
        b = pb
      }
    }
    return nodes[a]!.parents[0]!
  }
  const grafts = new Map<number, Graft[]>()
  const visit = (node: TabGroupLayoutNode): number | undefined => {
    if (node.type === 'leaf') {
      return indexByGroup.get(node.groupId)
    }
    const first = visit(node.first)
    const second = visit(node.second)
    if (first !== undefined && second !== undefined) {
      return commonAncestor(first, second)
    }
    const anchor = first ?? second
    if (anchor !== undefined) {
      const pending = grafts.get(anchor) ?? []
      pending.push({
        branch: node,
        missing: first === undefined ? node.first : node.second,
        anchorFirst: first !== undefined
      })
      grafts.set(anchor, pending)
    }
    return anchor
  }
  if (visit(prior) === undefined) {
    return appendTabGroupLayout(prior, incoming)
  }
  const apply = (node: TabGroupLayoutNode): TabGroupLayoutNode => {
    let next = node
    if (node.type === 'split') {
      const first = apply(node.first)
      const second = apply(node.second)
      if (first !== node.first || second !== node.second) {
        next = { ...node, first, second }
      }
    }
    for (const graft of grafts.get(indexByNode.get(node)!) ?? []) {
      next = {
        ...graft.branch,
        first: graft.anchorFirst ? next : graft.missing,
        second: graft.anchorFirst ? graft.missing : next
      }
    }
    return next
  }
  return apply(incoming)
}
