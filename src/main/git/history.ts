import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import { loadGitHistoryFromExecutor } from '../../shared/git-history'
import { gitExecFileAsync } from './runner'

export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  return loadGitHistoryFromExecutor(
    (args, cwd) => gitExecFileAsync(args, { cwd }),
    worktreePath,
    options
  )
}
