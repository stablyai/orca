import type { PersistedState } from '../../../shared/persisted-state-types'

/**
 * Tab ids owned by more than one host partition. Legacy alias keys (`tabId:1`) and acknowledgement
 * keys (`tabId:leafId`) carry no host segment, so such a tab id resolves to whichever partition was
 * migrated last — routing one host's pane at another host's terminal. Rewrite neither instead.
 */
export function findCrossHostPaneTabIds(state: PersistedState): ReadonlySet<string> {
  const seenTabIds = new Set<string>()
  const collidingTabIds = new Set<string>()
  for (const session of [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {})
  ]) {
    for (const tabId of Object.keys(session?.terminalLayoutsByTabId ?? {})) {
      if (seenTabIds.has(tabId)) {
        collidingTabIds.add(tabId)
        continue
      }
      seenTabIds.add(tabId)
    }
  }
  return collidingTabIds
}

export function withoutPaneTabIds(
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>,
  tabIds: ReadonlySet<string>
): Map<string, Map<string, string>> {
  if (tabIds.size === 0) {
    return leafIdByInputLeafIdByTabId
  }
  return new Map([...leafIdByInputLeafIdByTabId].filter(([tabId]) => !tabIds.has(tabId)))
}
