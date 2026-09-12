import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
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
    // Why: split terminal leaves share one parent tab; merge dedup must stay
    // leaf-scoped or preserved siblings collapse into a single surface.
    const keys = [tab.id, `${tab.parentTabId}::${tab.leafId}`]
    if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
      // Why: renderer and headless sources can derive different leafIds for the same
      // terminal; real PTYs collapse those duplicates without merging pending splits.
      keys.push(`${tab.parentTabId}::pty:${tab.ptyId}`)
    }
    return keys
  }
  if (tab.type === 'browser') {
    return [tab.id, tab.browserWorkspaceId]
  }
  return [tab.id]
}

export function mergeMobileSessionTabGroups(
  worktreeId: string,
  groups: readonly RuntimeMobileSessionTabGroup[],
  terminalTabs: readonly RuntimeMobileSessionTerminalTab[],
  activeTab: RuntimeMobileSessionTerminalTab | null
): RuntimeMobileSessionTabGroup[] {
  const parentTabOrder = collectHeadlessParentTabOrder(terminalTabs)
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
  // Why: keep each tab in the group that already owns it (a multi-group split
  // must survive the merge), drop tabs no longer present, and route only
  // genuinely-new tabs into the active group — never funnel everything into
  // group[0], which duplicated/coalesced tabs that lived in other groups.
  const ownerGroupId = new Map<string, string>()
  for (const group of nextGroups) {
    for (const tabId of group.tabOrder) {
      ownerGroupId.set(tabId, group.id)
    }
  }
  const liveTabIds = new Set(parentTabOrder)
  const activeParentId = activeTab?.parentTabId ?? null
  const activeGroupId =
    (activeParentId ? ownerGroupId.get(activeParentId) : undefined) ?? nextGroups[0]!.id
  const retainedOrder = new Map<string, string[]>(nextGroups.map((group) => [group.id, []]))
  // Why: tabOrder is the canonical user-visible order, so it must survive a republish.
  // A materialized idle surface can move to the end of terminalTabs; retaining the
  // stored order prevents activation from rotating the tab bar.
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
