import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
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
 * Closing a tab's last leaf closes the tab.
 */
export function closeTerminalSurfaceInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  options: { leafId?: string; force?: boolean } = {}
): WorkspaceSessionTerminalTabCloseResult {
  const layout = session.terminalLayoutsByTabId[tabId]
  if (options.leafId && layout && countTerminalLayoutLeaves(layout.root) > 1) {
    if (!layoutContainsLeafId(layout.root, options.leafId)) {
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
  return result.closed
    ? { ...result, session: advanceTerminalTopologyRevision(result.session, worktreeId) }
    : result
}
