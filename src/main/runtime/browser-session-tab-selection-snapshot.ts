import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

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
    : focusesHost
      ? groups.map((group) =>
          group.tabOrder.includes(tabId) ? { ...group, activeTabId: tabId } : group
        )
      : groups
  return {
    groups: nextGroups,
    placedInTargetGroup,
    snapshot: {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      ...(placedInTargetGroup && focusesHost ? { activeGroupId: targetGroupId } : {}),
      ...(focusesHost
        ? {
            activeTabId: tabId,
            activeTabType: 'browser' as const,
            tabs: snapshot.tabs.map((candidate) => ({
              ...candidate,
              isActive: candidate.id === tabId
            }))
          }
        : {}),
      tabGroups: nextGroups
    }
  }
}
