import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'
import {
  closeTerminalTabInWorkspaceSession,
  workspaceSessionListsTerminalTab
} from '../../shared/workspace-session-terminal-tab-close'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Removes every terminal tab this partition's own live close records name, from whichever writer
 * sent it back (a late renderer save, a relay snapshot, a fast patch). Tab ids are uuids, so a
 * recorded id is never a new tab; scoped to the record's worktree, and records past the TTL stop
 * suppressing. Main's rollback path bypasses this: it restores rows a failed close never committed.
 */
export function dropClosedTerminalTabs(
  session: WorkspaceSessionState,
  now = Date.now()
): WorkspaceSessionState {
  const records = session.closedTerminalTabTombstonesByTabId
  if (!records) {
    return session
  }
  // Why: a host slice omits terminal maps when that host has no terminal rows.
  const withMaps = {
    ...session,
    tabsByWorktree: session.tabsByWorktree ?? {},
    terminalLayoutsByTabId: session.terminalLayoutsByTabId ?? {}
  }
  let next: WorkspaceSessionState = withMaps
  for (const [tabId, { worktreeId }] of Object.entries(records)) {
    if (
      hasClosedTerminalTabRecord(records, tabId, undefined, now) &&
      workspaceSessionListsTerminalTab(next, worktreeId, tabId)
    ) {
      next = closeTerminalTabInWorkspaceSession(next, worktreeId, tabId, { force: true }).session
    }
  }
  // Leaves a sparse slice as sent when nothing was dropped.
  return next === withMaps ? session : next
}
