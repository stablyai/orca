import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** Restore required maps omitted by the renderer's sparse host split. */
export function withRequiredWorkspaceSessionMaps(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: session.tabsByWorktree ?? {},
    terminalLayoutsByTabId: session.terminalLayoutsByTabId ?? {}
  }
}
