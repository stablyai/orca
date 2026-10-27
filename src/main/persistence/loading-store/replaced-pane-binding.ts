import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RetiredTerminalSurface } from '../../runtime/mobile-session-terminal-retirement'

/** Caller proves old ownership; restart removes the binding while retaining the pane. */
export function clearReplacedPaneBinding(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface
): WorkspaceSessionState {
  const layout = session.terminalLayoutsByTabId[surface.parentTabId]
  if (!layout || layout.ptyIdsByLeafId?.[surface.leafId] !== surface.ptyId) {
    return session
  }
  const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
  delete ptyIdsByLeafId[surface.leafId]
  const terminalPtyIncarnationsByPaneKey = { ...session.terminalPtyIncarnationsByPaneKey }
  delete terminalPtyIncarnationsByPaneKey[`${surface.parentTabId}:${surface.leafId}`]
  return {
    ...session,
    terminalPtyIncarnationsByPaneKey,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [surface.parentTabId]: { ...layout, ptyIdsByLeafId }
    },
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [surface.worktreeId]: (session.tabsByWorktree[surface.worktreeId] ?? []).map((tab) =>
        tab.id === surface.parentTabId && tab.ptyId === surface.ptyId
          ? { ...tab, ptyId: null }
          : tab
      )
    }
  }
}
