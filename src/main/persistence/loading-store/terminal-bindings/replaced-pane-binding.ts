import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RetiredTerminalSurface } from '../../../runtime/terminal/surface/mobile-session-terminal-retirement'

/** `taken`: the saved leaf names another terminal, or the session lacks its tab, so retirement refuses. */
export function replacedPaneBindingState(
  session: WorkspaceSessionState,
  binding: { worktreeId: string; tabId: string; leafId: string; ptyId: string }
): 'unbound' | 'own' | 'taken' {
  const bound = session.terminalLayoutsByTabId?.[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
  if (!bound) {
    return 'unbound'
  }
  return bound === binding.ptyId &&
    session.tabsByWorktree?.[binding.worktreeId]?.some((tab) => tab.id === binding.tabId)
    ? 'own'
    : 'taken'
}

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
