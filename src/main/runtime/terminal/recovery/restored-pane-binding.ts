import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RestoredPane } from './restored-pane-start'

/** Undefined while unbound, null once the saved pane no longer exists. */
export function storedPaneBinding(
  session: WorkspaceSessionState | null | undefined,
  pane: RestoredPane
): string | null | undefined {
  const row = session?.tabsByWorktree?.[pane.worktreeId]?.find(
    (candidate) => candidate.id === pane.tabId
  )
  if (!row) {
    return null
  }
  const layout = session?.terminalLayoutsByTabId?.[pane.tabId]
  return layout ? layout.ptyIdsByLeafId?.[pane.leafId] : (row.ptyId ?? undefined)
}
