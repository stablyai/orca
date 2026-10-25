import type { PersistedState } from '../../../shared/persisted-state-types'

/** Hostless legacy/acknowledgement keys cannot disambiguate shared tab IDs; rewrite neither host. */
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
