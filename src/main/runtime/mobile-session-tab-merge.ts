import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import { collectTabGroupLayoutGroupIds } from '../../shared/workspace-layout/tab-group-moves'
import { isStructuredAgentSessionHostTabId } from '../../shared/structured-agent-session-host-tab-id'
import {
  collectHeadlessParentTabOrder,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'

export function mergeMobileSessionSnapshotTabs(
  baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
  extraTabs: readonly RuntimeMobileSessionSnapshotTab[]
): RuntimeMobileSessionSnapshotTab[] {
  const seenIds = new Set<string>()
  const merged: RuntimeMobileSessionSnapshotTab[] = []
  const add = (tab: RuntimeMobileSessionSnapshotTab): void => {
    const ids = getMobileSessionSnapshotTabIdentityKeys(tab)
    if (ids.some((id) => seenIds.has(id))) {
      return
    }
    for (const id of ids) {
      seenIds.add(id)
    }
    merged.push(tab)
  }
  for (const tab of baseTabs) {
    add(tab)
  }
  for (const tab of extraTabs) {
    add(tab)
  }
  return merged
}

export function getMobileSessionSnapshotTabIdentityKeys(
  tab: RuntimeMobileSessionSnapshotTab
): string[] {
  if (tab.type === 'terminal') {
    // Dedup split terminals by leaf or preserved siblings collapse into one surface.
    const keys = [tab.id, `${tab.parentTabId}::${tab.leafId}`]
    if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
      // PTY identity merges differing renderer/headless leaf ids without collapsing pending splits.
      keys.push(`${tab.parentTabId}::pty:${tab.ptyId}`)
    }
    return keys
  }
  if (tab.type === 'browser') {
    return [tab.id, tab.browserWorkspaceId]
  }
  return [tab.id]
}

export function getMobileSessionTabOrderIds(tab: RuntimeMobileSessionSnapshotTab): string[] {
  if (tab.type === 'terminal') {
    return [tab.id, tab.parentTabId]
  }
  if (tab.type === 'browser') {
    return [tab.id, tab.browserWorkspaceId]
  }
  return [tab.id]
}

/** Stable desktop strip order: groups left-to-right, then ungrouped tabs; retain split-pane order. */
export function orderMobileSessionTabsByGroups<T extends RuntimeMobileSessionSnapshotTab>(
  tabs: readonly T[],
  groups: readonly RuntimeMobileSessionTabGroup[],
  layout: TabGroupLayoutNode | null | undefined
): T[] {
  const groupRank = [...collectTabGroupLayoutGroupIds(layout)]
  const rankOfGroup = (group: RuntimeMobileSessionTabGroup): number => {
    const rank = groupRank.indexOf(group.id)
    return rank === -1 ? Number.POSITIVE_INFINITY : rank
  }
  const orderedGroups = groups.toSorted((a, b) => compareRanks(rankOfGroup(a), rankOfGroup(b)))
  const rankById = new Map<string, number>()
  for (const tabId of orderedGroups.flatMap((group) => group.tabOrder)) {
    if (!rankById.has(tabId)) {
      rankById.set(tabId, rankById.size)
    }
  }
  const rankOf = (tab: T): number =>
    Math.min(
      ...getMobileSessionTabOrderIds(tab).map((id) => rankById.get(id) ?? Number.POSITIVE_INFINITY)
    )
  return tabs
    .map((tab) => ({ tab, rank: rankOf(tab) }))
    .toSorted((a, b) => compareRanks(a.rank, b.rank))
    .map(({ tab }) => tab)
}

// Unranked Infinity - Infinity is NaN.
function compareRanks(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1
}

export function mergeMobileSessionTabGroups(
  worktreeId: string,
  groups: readonly RuntimeMobileSessionTabGroup[],
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  activeTab: RuntimeMobileSessionTerminalTab | null
): RuntimeMobileSessionTabGroup[] {
  const parentTabOrder = collectHeadlessParentTabOrder(
    tabs.filter((tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal')
  )
  if (parentTabOrder.length === 0) {
    return [...groups]
  }
  const targetGroupId = groups[0]?.id ?? getHeadlessMobileSessionGroupId(worktreeId)
  const nextGroups =
    groups.length > 0
      ? groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
      : [
          {
            id: targetGroupId,
            activeTabId: null,
            tabOrder: []
          }
        ]
  // Preserve existing group ownership; assign only new tabs to the active group.
  const ownerGroupId = new Map<string, string>()
  for (const group of nextGroups) {
    for (const tabId of group.tabOrder) {
      ownerGroupId.set(tabId, group.id)
    }
  }
  // Publishers place chats/editors/browsers; preserve listed chat positions before their rows restore.
  const liveTabIds = new Set([
    ...tabs.flatMap(getMobileSessionTabOrderIds),
    ...groups.flatMap((group) => group.tabOrder.filter(isStructuredAgentSessionHostTabId))
  ])
  const activeParentId = activeTab?.parentTabId ?? null
  const activeGroupId =
    (activeParentId ? ownerGroupId.get(activeParentId) : undefined) ?? nextGroups[0]!.id
  const retainedOrder = new Map<string, string[]>(nextGroups.map((group) => [group.id, []]))
  // Retain canonical tabOrder; materializing idle terminals can reorder incoming arrays.
  const placed = new Set<string>()
  for (const group of nextGroups) {
    for (const tabId of group.tabOrder) {
      if (liveTabIds.has(tabId) && !placed.has(tabId)) {
        retainedOrder.get(group.id)?.push(tabId)
        placed.add(tabId)
      }
    }
  }
  for (const tabId of parentTabOrder) {
    if (placed.has(tabId)) {
      continue
    }
    const groupId = ownerGroupId.get(tabId) ?? activeGroupId
    retainedOrder.get(groupId)?.push(tabId)
    placed.add(tabId)
  }
  return nextGroups
    .map((group) => {
      const tabOrder = retainedOrder.get(group.id) ?? []
      const keptActive =
        group.activeTabId &&
        tabOrder.includes(group.activeTabId) &&
        liveTabIds.has(group.activeTabId)
          ? group.activeTabId
          : null
      return {
        ...group,
        tabOrder,
        activeTabId:
          activeParentId && tabOrder.includes(activeParentId)
            ? activeParentId
            : (keptActive ?? tabOrder[0] ?? null)
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

/** Chats exist only in prior snapshots, so persisted terminal/layout rebuilds cannot recreate them. */
export function keepSnapshotChatTabs(
  rebuilt: readonly RuntimeMobileSessionSnapshotTab[],
  prior:
    | { tabs: readonly RuntimeMobileSessionSnapshotTab[]; activeTabId: string | null }
    | undefined
): RuntimeMobileSessionSnapshotTab[] {
  const chatTabs = prior?.tabs.filter((tab) => tab.type === 'agent-session') ?? []
  if (chatTabs.length === 0) {
    return [...rebuilt]
  }
  // Snapshot-selected chat outranks a rebuilt terminal's active flag.
  const activeChatId = chatTabs.find((tab) => tab.id === prior?.activeTabId)?.id ?? null
  return [
    ...rebuilt.map((tab) => (activeChatId && tab.isActive ? { ...tab, isActive: false } : tab)),
    ...chatTabs.map((tab) => ({ ...tab, isActive: tab.id === activeChatId }))
  ]
}

/** Restore chats to their prior group/preceding-tab position, falling back to the first group. */
export function appendChatTabOrder(
  groups: readonly RuntimeMobileSessionTabGroup[],
  priorGroups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  activeTabId: string | null = tabs.find((tab) => tab.isActive)?.id ?? null
): RuntimeMobileSessionTabGroup[] {
  const chatTabIds = tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.id)
  if (chatTabIds.length === 0) {
    return [...groups]
  }
  const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
  for (const tabId of chatTabIds) {
    const priorGroup = priorGroups?.find((group) => group.tabOrder.includes(tabId))
    const target =
      next.find((group) => group.tabOrder.includes(tabId)) ??
      next.find((group) => group.id === priorGroup?.id) ??
      next[0]
    if (!target) {
      continue
    }
    if (!target.tabOrder.includes(tabId)) {
      const at = chatInsertIndex(target.tabOrder, priorGroup?.tabOrder ?? [], tabId)
      target.tabOrder.splice(at, 0, tabId)
    }
    if (tabId === activeTabId) {
      target.activeTabId = tabId
    }
  }
  return next
}

function chatInsertIndex(
  order: readonly string[],
  priorOrder: readonly string[],
  tabId: string
): number {
  const priorIndex = priorOrder.indexOf(tabId)
  if (priorIndex === -1) {
    return order.length
  }
  const previous = priorOrder.slice(0, priorIndex).findLast((id) => order.includes(id))
  return previous === undefined ? 0 : order.indexOf(previous) + 1
}
