import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** The tab is the one its workspace, or one of its split groups, shows; a tab behind another is not.
 *  The window publishes a chat's tab under the same id in the tabs, the groups and the active tab. */
export function snapshotShowsTab(
  snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'activeTabId' | 'tabGroups'>,
  tabId: string
): boolean {
  return (
    snapshot.activeTabId === tabId ||
    (snapshot.tabGroups ?? []).some((group) => group.activeTabId === tabId)
  )
}
