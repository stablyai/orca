import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { loadGitHistoryFromExecutor } from '../../shared/git-history'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions & GitRuntimeOptions = {}
): Promise<GitHistoryResult> {
  return withLocalGitCapabilityCacheForExecution(
    { cwd: worktreePath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      loadGitHistoryFromExecutor(
        (args, cwd) => gitExecFileAsync(args, gitOptionsForWorktree(cwd, options)),
        worktreePath,
        options,
        capabilities
      )
  )
}
