import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** A conditional rename's admission, read from the partition inside the durable write: refuse when the tab's manual name differs. */
export function manualTitleAdmission(
  partitions: readonly WorkspaceSessionState[] | undefined,
  pane: { worktreeId: string; tabId: string },
  expected: string
): boolean | 'terminal_title_changed' {
  const tab = partitions?.[0]?.tabsByWorktree[pane.worktreeId]?.find(
    (candidate) => candidate.id === pane.tabId
  )
  if (!tab) {
    return false
  }
  return (tab.customTitle?.trim() || '') === expected.trim() || 'terminal_title_changed'
}
