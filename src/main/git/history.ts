import { resolveWorktreeHostPath } from '../../shared/git/metadata/git-metadata-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { loadGitHistoryRefs } from '../../shared/git/history/git-history-revisions'
import type {
  GitHistoryOptions,
  GitHistoryResult
} from '../../shared/git/history/git-history-types'
import { loadGitHistoryFromExecutor } from '../../shared/git/history/git-history-execution'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './command-runner/git-exec-file'

export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions & GitRuntimeOptions = {}
): Promise<GitHistoryResult> {
  return loadGitHistoryFromExecutor(
    (args, cwd, stdin) =>
      gitExecFileAsync(args, {
        ...gitOptionsForWorktree(cwd, options),
        ...(stdin !== undefined ? { stdin } : {})
      }),
    worktreePath,
    options
  )
}

export async function getHistoryRefs(
  worktreePath: string,
  query?: string,
  options: GitRuntimeOptions = {}
) {
  return (
    await loadGitHistoryRefs(
      (args, cwd, stdin) =>
        gitExecFileAsync(args, {
          ...gitOptionsForWorktree(cwd, options),
          ...(stdin !== undefined ? { stdin } : {})
        }),
      worktreePath,
      query
    )
  )
    .slice(0, 1000)
    .map((ref) =>
      ref.worktreePath
        ? {
            ...ref,
            worktreePath:
              resolveWorktreeHostPath(ref.worktreePath, {
                wslDistro: parseWslUncPath(worktreePath)?.distro ?? options.wslDistro
              }) ?? ref.worktreePath
          }
        : ref
    )
}
