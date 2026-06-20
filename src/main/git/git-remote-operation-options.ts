import { GIT_REMOTE_OPERATION_TIMEOUT_MS } from '../../shared/git-remote-operation-timeout'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'

export function gitRemoteOperationOptionsForWorktree(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): ReturnType<typeof gitOptionsForWorktree> & { timeout: number; killProcessTree: true } {
  return {
    ...gitOptionsForWorktree(worktreePath, options),
    // Why: credential helpers, hooks, and remote transports can stall without
    // returning control to Source Control; bound and clean up the whole tree.
    timeout: GIT_REMOTE_OPERATION_TIMEOUT_MS,
    killProcessTree: true
  }
}
