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

/**
 * A tab list rebuilt from persisted state, plus the chat tabs only `prior` holds. Chat tabs exist
 * only in the runtime's snapshot, so no persisted terminal or layout state can recreate them.
 */
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
  // One active tab: a rebuilt terminal's own flag must not outrank the chat the snapshot showed.
  const activeChatId = chatTabs.find((tab) => tab.id === prior?.activeTabId)?.id ?? null
  return [
    ...rebuilt.map((tab) => (activeChatId && tab.isActive ? { ...tab, isActive: false } : tab)),
    ...chatTabs.map((tab) => ({ ...tab, isActive: tab.id === activeChatId }))
  ]
}

/**
 * Puts chat tabs back into the group order a terminal-only merge rebuilt without them: each in the
 * group that listed it before (else the first), after the tab it followed there.
 */
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
