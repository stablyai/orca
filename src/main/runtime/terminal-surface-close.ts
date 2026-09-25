import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { recordClosedTerminalTabTombstone } from '../../shared/closed-terminal-tab-tombstones'
import {
  closeTerminalTabInWorkspaceSession,
  type WorkspaceSessionTerminalTabCloseResult
} from '../../shared/workspace-session-terminal-tab-close'
import { layoutContainsLeafId } from '../persistence/restoring-sessions/terminal-layout-normalization'
import { countTerminalLayoutLeaves } from './headless-terminal-split-layout'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

/**
 * The membership half of every explicit terminal close: removes a tab, or one leaf of a split
 * tab, and advances the repo's topology revision so a stale renderer save cannot restore it.
 * A leaf close never removes its tab: callers close the last pane with a tab close. Every tab close
 * is recorded in the session it was removed from, which is the owning host's partition.
 */
export function closeTerminalSurfaceInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  options: {
    leafId?: string
    force?: boolean
    reason: RuntimeSessionTabCloseReason
    now?: number
  }
): WorkspaceSessionTerminalTabCloseResult {
  const layout = session.terminalLayoutsByTabId[tabId]
  if (options.leafId) {
    // Why: the exit may already have retired this leaf, leaving only live siblings to lose.
    if (
      !layout ||
      countTerminalLayoutLeaves(layout.root) <= 1 ||
      !layoutContainsLeafId(layout.root, options.leafId)
    ) {
      return { session, ptyIdsToKill: [], closed: false, pinned: false }
    }
    // The leaf's own binding is passed so the retirement's stale-binding fence always admits it.
    const retired = retireTerminalSurfaceFromPersistence(session, {
      worktreeId,
      parentTabId: tabId,
      leafId: options.leafId,
      ptyId: layout.ptyIdsByLeafId?.[options.leafId] ?? ''
    })
    return { session: retired, ptyIdsToKill: [], closed: true, pinned: false }
  }
  const result = closeTerminalTabInWorkspaceSession(session, worktreeId, tabId, {
    force: options.force
  })
  // Why a tab this session never listed is still recorded: its spawn may commit later and graft it.
  if (result.pinned) {
    return result
  }
  const recorded: WorkspaceSessionState = {
    ...result.session,
    closedTerminalTabTombstonesByTabId: recordClosedTerminalTabTombstone(
      result.session.closedTerminalTabTombstonesByTabId,
      tabId,
      { worktreeId, reason: options.reason },
      options.now ?? Date.now()
    )
  }
  return {
    ...result,
    session: result.closed ? advanceTerminalTopologyRevision(recorded, worktreeId) : recorded
  }
}
