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
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import type { GetStatusOptions } from './get-status-options'

export function createBranchLineTotalInput(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GetStatusOptions,
  statusSucceeded: boolean
):
  | { mergeBase: string; compute: () => Promise<GitBranchLineTotal | null | undefined> }
  | undefined {
  const mergeBase = readGitBranchLineTotalMergeBaseParam(options.branchLineTotalMergeBase)
  // Failed status leaves the untracked list incomplete; omit rather than under-count the total.
  if (mergeBase === undefined || !statusSucceeded) {
    return undefined
  }
  return {
    mergeBase,
    compute: () =>
      computeGitBranchLineTotal({
        worktreePath,
        // Direct file reads need Node's path spelling.
        filesystemWorktreePath: resolveWorktreeFilesystemPath(worktreePath, options),
        // Identical paths can name different filesystems in different WSL distros.
        hostKey: options.wslDistro ?? 'native',
        mergeBase,
        untrackedPaths: entries
          .filter((entry) => entry.area === 'untracked')
          .map((entry) => entry.path),
        runDiffNumstat: (args, signal) =>
          gitExecFileAsync(args, {
            ...gitReadOptionsForWorktree(worktreePath, options),
            // The shared lease owns cancellation, not this individual caller.
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
  // Scope filesystem stats to Git's execution host, including the WSL distro.
  return `${options.wslDistro ?? 'native'}\0${worktreePath}`
}
