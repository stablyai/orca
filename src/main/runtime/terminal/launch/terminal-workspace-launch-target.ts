import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

export type LaunchScopeOptions = {
  wslUserAct?: boolean
  readOnly?: boolean
  requiredHostId?: ExecutionHostId
}

export type ResolvedTerminalWorkspaceLaunchTarget = {
  scope: TerminalWorkspaceLaunchScope
  managedWorktree: ResolvedWorktree | null
}
