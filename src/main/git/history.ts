import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { loadHistoryFromExecutors } from '../../shared/git-history'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { commandExecFileAsync, gitExecFileAsync } from './runner'

export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions & GitRuntimeOptions = {}
): Promise<GitHistoryResult> {
  return loadHistoryFromExecutors(
    {
      git: (args, cwd) => gitExecFileAsync(args, gitOptionsForWorktree(cwd, options)),
      jj: (args, cwd) =>
        commandExecFileAsync('jj', args, {
          cwd,
          timeout: 15_000,
          signal: options.signal
        })
    },
    worktreePath,
    options
  )
}
