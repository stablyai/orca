import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionSnapshotTab
} from '../../shared/runtime-types'
import { retireMobileSessionTabSelection } from './session-tabs/mobile-session-tab-selection'

// Terminal-only rebuilds drop browser ids; restore their prior group, assigning only new browsers to target/first group.
export function appendBrowserTabOrder(
  groups: readonly RuntimeMobileSessionTabGroup[],
  browserTabIds: readonly string[],
  newTabAssignment?: { tabId: string; groupId: string },
  // Carry browser ownership across terminal-only tabOrder rebuilds.
  priorGroupByBrowserId?: ReadonlyMap<string, string>
): RuntimeMobileSessionTabGroup[] {
  if (browserTabIds.length === 0) {
    return [...groups]
  }
  const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
  if (next.length === 0) {
    return next
  }
  const groupById = new Map(next.map((group) => [group.id, group]))
  const ownerGroupByTabId = new Map<string, RuntimeMobileSessionTabGroup>()
  for (const group of next) {
    for (const id of group.tabOrder) {
      ownerGroupByTabId.set(id, group)
    }
  }
  for (const id of browserTabIds) {
    if (ownerGroupByTabId.has(id)) {
      continue
    }
    const priorGroupId = priorGroupByBrowserId?.get(id)
    const targetGroup =
      (newTabAssignment?.tabId === id ? groupById.get(newTabAssignment.groupId) : undefined) ??
      (priorGroupId ? groupById.get(priorGroupId) : undefined) ??
      next[0]!
    targetGroup.tabOrder.push(id)
  }
  return next
}

export function collectBrowserGroupAssignment(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  browserTabIds: readonly string[]
): Map<string, string> {
  const browserIdSet = new Set(browserTabIds)
  const assignment = new Map<string, string>()
  for (const group of groups ?? []) {
    for (const id of group.tabOrder) {
      if (browserIdSet.has(id)) {
        assignment.set(id, group.id)
      }
    }
  }
  return assignment
}

export function withReconciledBrowserTabs(
  existing: RuntimeMobileSessionTabsSnapshot,
  tabs: RuntimeMobileSessionSnapshotTab[],
  liveIds: string[],
  priorIds: ReadonlySet<string>
): RuntimeMobileSessionTabsSnapshot {
  const live = new Set(liveIds)
  for (const tab of tabs) {
    if (tab.type === 'browser' && live.has(tab.id)) {
      live.add(tab.browserWorkspaceId)
    }
  }
  return retireMobileSessionTabSelection(
    {
      ...existing,
      snapshotVersion: existing.snapshotVersion + 1,
      ...(existing.tabGroups !== undefined
        ? { tabGroups: appendBrowserTabOrder(existing.tabGroups, liveIds) }
        : {})
    },
    tabs,
    new Set([...priorIds].filter((id) => !live.has(id)))
  )
}
