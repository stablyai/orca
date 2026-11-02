import type { PersistedState } from '../../../shared/persisted-state-types'
import { buildWorktreeIdByTabId } from '../../../shared/workspace-session-host-records'
import { isWslMoveWorkspaceHostOwned } from '../moving-wsl-projects/wsl-move-scope-guard'

/**
 * Tab ids owned by more than one host partition. Legacy alias keys (`tabId:1`) and acknowledgement
 * keys (`tabId:leafId`) carry no host segment, so such a tab id resolves to whichever partition was
 * migrated last — routing one host's pane at another host's terminal. Rewrite neither instead.
 * A WSL-moved workspace's local rows are a dormant downgrade copy of its host's, not a rival.
 */
export function findCrossHostPaneTabIds(
  state: PersistedState,
  isRetainedLocalWorkspace: (workspaceId: string) => boolean = isWslMoveWorkspaceHostOwned
): ReadonlySet<string> {
  const seenTabIds = new Set<string>()
  const collidingTabIds = new Set<string>()
  const localWorkspaceByTabId = buildWorktreeIdByTabId(state.workspaceSession ?? {})
  const sessions = [
    { session: state.workspaceSession, local: true },
    ...Object.values(state.workspaceSessionsByHostId ?? {}).map((session) => ({
      session,
      local: false
    }))
  ]
  for (const { session, local } of sessions) {
    for (const tabId of Object.keys(session?.terminalLayoutsByTabId ?? {})) {
      const workspaceId = local ? localWorkspaceByTabId.get(tabId) : undefined
      if (workspaceId && isRetainedLocalWorkspace(workspaceId)) {
        continue
      }
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
