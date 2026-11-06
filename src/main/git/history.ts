import type {
  GitHistoryOptions,
  GitHistoryResult
} from '../../shared/git/history/git-history-types'
import { loadGitHistoryFromExecutor } from '../../shared/git/history/git-history-execution'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions & GitRuntimeOptions = {}
): Promise<GitHistoryResult> {
  return loadGitHistoryFromExecutor(
    (args, cwd) => gitExecFileAsync(args, gitOptionsForWorktree(cwd, options)),
    worktreePath,
    options
  )
}
