import { hasClosedTerminalTabRecord } from '../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import {
  closeTerminalTabInWorkspaceSession,
  workspaceSessionListsTerminalTab
} from '../../shared/workspace-session/workspace-session-terminal-tab-close'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

/** Suppress recorded closes across all writers until TTL expiry; failed-close rollback bypasses the fence. `closedIn` collects the workspaces it closed a tab in. */
export function dropClosedTerminalTabs(
  session: WorkspaceSessionState,
  now = Date.now(),
  closedIn?: Set<string>
): WorkspaceSessionState {
  const records = session.closedTerminalTabTombstonesByTabId
  if (!records) {
    return session
  }
  // Empty host slices may omit terminal maps.
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
      closedIn?.add(worktreeId)
    }
  }
  // Keep sparse slices sparse when no tabs were dropped.
  return next === withMaps ? session : next
}
