import { retryOnGitLockContention } from '../../../../shared/git/commands/git-lock-contention'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { gitExecOptions } from '../worktree-operation-options'

// Why: concurrent worktree creates share the repo's .git/config, and git fails at once on a held config.lock.
export function gitConfigWrite(
  args: string[],
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<unknown> {
  return retryOnGitLockContention(() =>
    gitExecFileAsync(args, { ...gitExecOptions(worktreePath, options) })
  )
}
