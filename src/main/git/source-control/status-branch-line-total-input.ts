import type { GitStatusEntry } from '../../../shared/git-status-types'
import {
  computeGitBranchLineTotal,
  readGitBranchLineTotalMergeBaseParam,
  GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS,
  type GitBranchLineTotal
} from '../../../shared/git-branch-line-total'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import type { GetStatusOptions } from './get-status-options'

/** Undefined — and therefore zero extra work — unless the caller asked for a total we can know exact. */
export function createBranchLineTotalInput(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GetStatusOptions,
  statusSucceeded: boolean
): { mergeBase: string; compute: () => Promise<GitBranchLineTotal | undefined> } | undefined {
  const mergeBase = readGitBranchLineTotalMergeBaseParam(options.branchLineTotalMergeBase)
  // Why: a failed status scan leaves the untracked list untrustworthy, so the
  // total would silently under-count rather than be absent.
  if (mergeBase === undefined || !statusSucceeded) {
    return undefined
  }
  return {
    mergeBase,
    compute: () =>
      computeGitBranchLineTotal({
        worktreePath,
        // Why: the same path can be a different filesystem per WSL distro.
        hostKey: options.wslDistro ?? 'native',
        mergeBase,
        untrackedPaths: entries
          .filter((entry) => entry.area === 'untracked')
          .map((entry) => entry.path),
        runDiffNumstat: (args, signal) =>
          gitExecFileAsync(args, {
            ...gitReadOptionsForWorktree(worktreePath, options),
            // Why: after the spread, so the shared lease signal wins over this caller's own.
            signal,
            env: gitOptionalLocksDisabledEnv(),
            timeout: GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS
          }).then((result) => result.stdout),
        ...(options.signal ? { signal: options.signal } : {})
      })
  }
}

export function getStatusLineStatsCacheKey(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): string {
  // Why: identical paths can map to different WSL-distro filesystems, so key stats by Git's execution host.
  return `${options.wslDistro ?? 'native'}\0${worktreePath}`
}
