import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
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
  let next = session
  for (const [tabId, record] of Object.entries(records)) {
    const { worktreeId } = record
    // Why the guard: a host slice omits terminal maps when that host has no terminal rows.
    const listed =
      next.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) ||
      next.unifiedTabs?.[worktreeId]?.some(
        (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
      )
    if (listed && hasClosedTerminalTabRecord(records, tabId, undefined, now)) {
      const required = {
        tabsByWorktree: next.tabsByWorktree ?? {},
        terminalLayoutsByTabId: next.terminalLayoutsByTabId ?? {}
      }
      next = closeTerminalTabInWorkspaceSession({ ...next, ...required }, worktreeId, tabId, {
        force: true
      }).session
    }
  }
  return next
}
