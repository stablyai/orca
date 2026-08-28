import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

type SessionTabGroup = NonNullable<RuntimeMobileSessionTabsSnapshot['tabGroups']>[number]

export type BrowserSessionTabSelectionResult = {
  snapshot: RuntimeMobileSessionTabsSnapshot
  groups: SessionTabGroup[]
  /** The tab was moved into the requested group, so its membership is worth persisting. */
  placedInTargetGroup: boolean
}

/**
 * Fold a created browser tab into the shared session snapshot.
 *
 * Two independent effects live here and must stay separable: the tab has to land in the group whose
 * "+" was clicked whoever asked for it, while the snapshot's active tab may only move when the
 * request reaches the host. A create from one paired device sets `focusesHost: false` — it still
 * places the tab, but the host desktop and every other device keep looking at what they had.
 */
export function applyBrowserSessionTabSelection(args: {
  snapshot: RuntimeMobileSessionTabsSnapshot
  tabId: string
  targetGroupId?: string
  focusesHost: boolean
  publicationEpoch: string
}): BrowserSessionTabSelectionResult {
  const { snapshot, tabId, targetGroupId, focusesHost } = args
  const groups = snapshot.tabGroups ?? []
  const placedInTargetGroup =
    targetGroupId !== undefined && groups.some((group) => group.id === targetGroupId)
  // Why: move the new browser into the group whose "+" was clicked, removing it from wherever the
  // rebuild placed it. Only the TARGET group's activeTabId (and the global active) change — every
  // other group's active tab is left intact, so creating in the right group never resets the left
  // group's tab.
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
      publicationEpoch: args.publicationEpoch,
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
