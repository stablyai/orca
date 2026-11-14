import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

export abstract class WorkspaceSessionRuntime {
  protected abstract getWorkspaceSessionForWorktree(
    worktreeId: string
  ): WorkspaceSessionState | null
  protected abstract borrowWorkspaceSessionForWorktree(
    worktreeId: string
  ): WorkspaceSessionState | null
}
