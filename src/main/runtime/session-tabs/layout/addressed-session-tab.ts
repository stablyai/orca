import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** The tab a client's tab id names: the tab itself, a terminal by its parent tab, or a browser by
 *  its browser workspace. */
export function findAddressedSessionTab(
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'] | undefined,
  tabId: string
): RuntimeMobileSessionTabsSnapshot['tabs'][number] | undefined {
  return (
    tabs?.find((candidate) => candidate.id === tabId) ??
    tabs?.find((candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId) ??
    tabs?.find(
      (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
    )
  )
}
