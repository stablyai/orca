import type { TabGroupLayoutNode } from '../../shared/types'

function collectLayoutGroupIds(node: TabGroupLayoutNode | null | undefined, ids: string[]): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    ids.push(node.groupId)
    return
  }
  collectLayoutGroupIds(node.first, ids)
  collectLayoutGroupIds(node.second, ids)
}

function pruneLayout(
  node: TabGroupLayoutNode | null | undefined,
  retainedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return retainedGroupIds.has(node.groupId) ? node : null
  }
  const first = pruneLayout(node.first, retainedGroupIds)
  const second = pruneLayout(node.second, retainedGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function appendMissingGroups(
  layout: TabGroupLayoutNode | null,
  orderedGroupIds: readonly string[]
): TabGroupLayoutNode | null {
  const present: string[] = []
  collectLayoutGroupIds(layout, present)
  const presentSet = new Set(present)
  let next = layout
  for (const groupId of orderedGroupIds) {
    if (presentSet.has(groupId)) {
      continue
    }
    const leaf = { type: 'leaf' as const, groupId }
    next = next
      ? { type: 'split', direction: 'horizontal', first: next, second: leaf, ratio: 0.5 }
      : leaf
    presentSet.add(groupId)
  }
  return next
}

function replaceLeaf(
  node: TabGroupLayoutNode,
  groupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (node.type === 'leaf') {
    return node.groupId === groupId ? replacement : node
  }
  return {
    ...node,
    first: replaceLeaf(node.first, groupId, replacement),
    second: replaceLeaf(node.second, groupId, replacement)
  }
}

export function hasExactTerminalOrphanGroupLayout(
  layout: TabGroupLayoutNode,
  expectedGroupIds: ReadonlySet<string>
): boolean {
  const groupIds: string[] = []
  collectLayoutGroupIds(layout, groupIds)
  return (
    groupIds.length === expectedGroupIds.size &&
    new Set(groupIds).size === groupIds.length &&
    groupIds.every((groupId) => expectedGroupIds.has(groupId))
  )
}

export function mergeTerminalOrphanGroupLayout(args: {
  existingLayout: TabGroupLayoutNode | null | undefined
  existingGroupIds: readonly string[]
  proposedLayout: TabGroupLayoutNode | null | undefined
  proposedGroupIds: readonly string[]
  mergedGroupIds: readonly string[]
}): TabGroupLayoutNode | undefined {
  const mergedGroupIdSet = new Set(args.mergedGroupIds)
  const existingGroupIdSet = new Set(args.existingGroupIds)
  const proposedGroupIdSet = new Set(args.proposedGroupIds)
  let existing = appendMissingGroups(
    pruneLayout(args.existingLayout, existingGroupIdSet),
    args.existingGroupIds
  )
  const proposed = appendMissingGroups(
    pruneLayout(args.proposedLayout, proposedGroupIdSet),
    args.proposedGroupIds
  )

  if (!existing) {
    return appendMissingGroups(proposed, args.mergedGroupIds) ?? undefined
  }
  if (!proposed) {
    return appendMissingGroups(existing, args.mergedGroupIds) ?? undefined
  }

  const sharedGroupIds = args.proposedGroupIds.filter((groupId) => existingGroupIdSet.has(groupId))
  const newGroupIds = new Set(
    args.proposedGroupIds.filter((groupId) => !existingGroupIdSet.has(groupId))
  )
  if (newGroupIds.size > 0 && sharedGroupIds.length === 1) {
    // One shared group identifies where the recovered subtree belonged without disturbing unrelated host layout.
    const anchorGroupId = sharedGroupIds[0]!
    const proposalAtAnchor = pruneLayout(proposed, new Set([anchorGroupId, ...newGroupIds]))
    if (proposalAtAnchor) {
      existing = replaceLeaf(existing, anchorGroupId, proposalAtAnchor)
    }
  } else if (newGroupIds.size > 0) {
    // With no unique anchor, append the intact recovered subtree so ambiguous client metadata cannot rewrite host groups.
    const newSubtree = pruneLayout(proposed, newGroupIds)
    if (newSubtree) {
      existing = {
        type: 'split',
        direction: proposed.type === 'split' ? proposed.direction : 'horizontal',
        first: existing,
        second: newSubtree,
        ratio: proposed.type === 'split' ? proposed.ratio : 0.5
      }
    }
  }

  return (
    appendMissingGroups(pruneLayout(existing, mergedGroupIdSet), args.mergedGroupIds) ?? undefined
  )
}
