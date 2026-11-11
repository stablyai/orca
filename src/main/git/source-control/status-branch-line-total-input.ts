import type {
  GitStatusEntry,
  GitBranchLineTotal
} from '../../../shared/git/status/git-status-types'
import {
  computeGitBranchLineTotal,
  readGitBranchLineTotalMergeBaseParam,
  GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS
} from '../../../shared/git/status/git-branch-line-total'

import { type GitRuntimeOptions, gitReadOptionsForWorktree } from '../git-runtime-options'
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

/** True for a status key (line-stats or read lease) of `worktreePath` under any execution host. */
export function isStatusKeyForWorktreePath(key: string, worktreePath: string): boolean {
  const scoped = key.slice(key.indexOf('\0') + 1)
  return scoped === worktreePath || scoped.startsWith(`${worktreePath}\0`)
}

export function getStatusLineStatsCacheKey(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): string {
  // Scope filesystem stats to Git's execution host, including the WSL distro.
  return `${options.wslDistro ?? 'native'}\0${worktreePath}`
}
