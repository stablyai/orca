import type { RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/types'

/**
 * Headless ("Orca server") tab-GROUP split operations (distinct from terminal
 * PANE splits inside one tab). The headless host historically coalesced every
 * tab into a single group, so a client drag-to-split-group was lost on the next
 * snapshot. These pure helpers let the host model + persist a real multi-group
 * layout, mirroring the renderer's buildSplitNode/replaceLeaf semantics so host
 * and client agree on the tree.
 */

type SplitDirection = 'left' | 'right' | 'up' | 'down'

function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: 'horizontal' | 'vertical',
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf,
    ratio: 0.5
  }
}

function replaceLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? replacement : root
  }
  return {
    ...root,
    first: replaceLeaf(root.first, targetGroupId, replacement),
    second: replaceLeaf(root.second, targetGroupId, replacement)
  }
}

/** Collect every groupId referenced by a layout tree. */
export function collectTabGroupLayoutGroupIds(
  node: TabGroupLayoutNode | null | undefined,
  groupIds = new Set<string>()
): Set<string> {
  if (!node) {
    return groupIds
  }
  if (node.type === 'leaf') {
    groupIds.add(node.groupId)
    return groupIds
  }
  collectTabGroupLayoutGroupIds(node.first, groupIds)
  collectTabGroupLayoutGroupIds(node.second, groupIds)
  return groupIds
}

/** Remove a leaf from the tree, collapsing the parent split into the sibling. */
export function removeTabGroupLayoutLeaf(
  root: TabGroupLayoutNode | null | undefined,
  groupId: string
): TabGroupLayoutNode | null {
  if (!root) {
    return null
  }
  if (root.type === 'leaf') {
    return root.groupId === groupId ? null : root
  }
  const first = removeTabGroupLayoutLeaf(root.first, groupId)
  const second = removeTabGroupLayoutLeaf(root.second, groupId)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...root, first, second }
}

export type HeadlessTabGroupMoveResult = {
  groups: RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode | null
}

/**
 * Move `tabId` into an EXISTING `targetGroupId` (a non-split drop), mirroring the
 * renderer's move-to-group path. Inserts at `index` (clamped), removes the tab
 * from its source group, and drops a source group emptied by the move (collapsing
 * it out of the layout). Returns null when the tab/target is missing or it's a
 * same-group no-op.
 */
export function buildHeadlessTabGroupMove(args: {
  groups: readonly RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode | null | undefined
  tabId: string
  targetGroupId: string
  index?: number
}): HeadlessTabGroupMoveResult | null {
  const sourceGroup = args.groups.find((group) => group.tabOrder.includes(args.tabId))
  const targetGroup = args.groups.find((group) => group.id === args.targetGroupId)
  if (!sourceGroup || !targetGroup) {
    return null
  }
  if (sourceGroup.id === args.targetGroupId) {
    return null
  }

  let groups: RuntimeMobileSessionTabGroup[] = args.groups.map((group) => {
    if (group.id === sourceGroup.id) {
      const tabOrder = group.tabOrder.filter((id) => id !== args.tabId)
      return {
        ...group,
        tabOrder,
        activeTabId: group.activeTabId === args.tabId ? (tabOrder[0] ?? null) : group.activeTabId
      }
    }
    if (group.id === args.targetGroupId) {
      const tabOrder = group.tabOrder.filter((id) => id !== args.tabId)
      const at = Math.max(0, Math.min(args.index ?? tabOrder.length, tabOrder.length))
      tabOrder.splice(at, 0, args.tabId)
      return { ...group, tabOrder, activeTabId: args.tabId }
    }
    return group
  })

  groups = groups.filter((group) => group.tabOrder.length > 0)
  const liveGroupIds = new Set(groups.map((group) => group.id))
  let layout: TabGroupLayoutNode | null = args.layout ?? null
  for (const groupId of collectTabGroupLayoutGroupIds(args.layout)) {
    if (!liveGroupIds.has(groupId)) {
      layout = removeTabGroupLayoutLeaf(layout, groupId)
    }
  }
  return { groups, layout }
}

export type HeadlessTabGroupSplitResult = {
  groups: RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode
  newGroupId: string
}

/**
 * Move `tabId` out of its current group into a NEW group split off from
 * `targetGroupId` in `splitDirection`, mirroring the renderer's dropUnifiedTab
 * split path. Returns the next groups + group layout tree.
 *
 * Returns null when the move can't apply (tab/group missing, or it would split
 * the only tab off its own group — a renderer-side no-op).
 */
export function buildHeadlessTabGroupSplit(args: {
  groups: readonly RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode | null | undefined
  tabId: string
  targetGroupId: string
  splitDirection: SplitDirection
  newGroupId: string
}): HeadlessTabGroupSplitResult | null {
  const sourceGroup = args.groups.find((group) => group.tabOrder.includes(args.tabId))
  if (!sourceGroup) {
    return null
  }
  // Splitting the last tab off its own group would create a sibling only to
  // immediately collapse the empty source — a no-op the renderer skips too.
  if (sourceGroup.id === args.targetGroupId && sourceGroup.tabOrder.length <= 1) {
    return null
  }

  const direction =
    args.splitDirection === 'left' || args.splitDirection === 'right' ? 'horizontal' : 'vertical'
  const position =
    args.splitDirection === 'left' || args.splitDirection === 'up' ? 'first' : 'second'

  const baseLayout: TabGroupLayoutNode = args.layout ?? {
    type: 'leaf',
    groupId: args.targetGroupId
  }
  const layout = replaceLeaf(
    baseLayout,
    args.targetGroupId,
    buildSplitNode(args.targetGroupId, args.newGroupId, direction, position)
  )

  const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== args.tabId)
  let groups: RuntimeMobileSessionTabGroup[] = args.groups.map((group) => {
    if (group.id === sourceGroup.id) {
      return {
        ...group,
        tabOrder: sourceOrder,
        activeTabId: group.activeTabId === args.tabId ? (sourceOrder[0] ?? null) : group.activeTabId
      }
    }
    return group
  })
  groups.push({ id: args.newGroupId, activeTabId: args.tabId, tabOrder: [args.tabId] })
  // Drop any group emptied by the move and collapse it out of the layout.
  groups = groups.filter((group) => group.tabOrder.length > 0)
  const liveGroupIds = new Set(groups.map((group) => group.id))
  let prunedLayout: TabGroupLayoutNode | null = layout
  for (const groupId of collectTabGroupLayoutGroupIds(layout)) {
    if (!liveGroupIds.has(groupId)) {
      prunedLayout = removeTabGroupLayoutLeaf(prunedLayout, groupId)
    }
  }

  return {
    groups,
    layout: prunedLayout ?? { type: 'leaf', groupId: args.newGroupId },
    newGroupId: args.newGroupId
  }
}
