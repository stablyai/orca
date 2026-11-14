import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { selectMobileSessionTab } from '../../session-tabs/mobile-session-tab-selection'

type SessionTabGroup = NonNullable<RuntimeMobileSessionTabsSnapshot['tabGroups']>[number]

export type BrowserSessionTabSelectionResult = {
  snapshot: RuntimeMobileSessionTabsSnapshot
  groups: SessionTabGroup[]
  placedInTargetGroup: boolean
}

/** Place in the requested group regardless of focus; only host-targeted creates change shared selection. */
export function applyBrowserSessionTabSelection(args: {
  snapshot: RuntimeMobileSessionTabsSnapshot
  tabId: string
  targetGroupId?: string
  focusesHost: boolean
}): BrowserSessionTabSelectionResult {
  const { snapshot, tabId, targetGroupId, focusesHost } = args
  const groups = snapshot.tabGroups ?? []
  const placedInTargetGroup =
    targetGroupId !== undefined && groups.some((group) => group.id === targetGroupId)
  // Move membership without changing other groups' active tabs.
  const nextGroups = placedInTargetGroup
    ? groups.map((group) => {
        const withoutTab = group.tabOrder.filter((id) => id !== tabId)
        if (group.id === targetGroupId) {
          return {
            ...group,
            tabOrder: [...withoutTab, tabId],
            ...(focusesHost ? { activeTabId: tabId } : {})
          }
        }
        return withoutTab.length === group.tabOrder.length
          ? group
          : { ...group, tabOrder: withoutTab }
      })
    : groups
  const placedSnapshot = {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    ...(snapshot.tabGroups !== undefined ? { tabGroups: nextGroups } : {})
  }
  const nextSnapshot = focusesHost
    ? selectMobileSessionTab(placedSnapshot, snapshot.tabs.find((tab) => tab.id === tabId) ?? null)
    : placedSnapshot
  return {
    groups: nextSnapshot.tabGroups ?? [],
    placedInTargetGroup,
    snapshot: nextSnapshot
  }
}
