import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitConflictOperation } from '../../../../shared/git/status/git-status-types'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../git-read-cache-invalidation'
import { resolveGitDir } from '../resolve-git-dir'

// HEAD detection races may yield unknown for one poll; rebase directories persist more reliably than REBASE_HEAD.
export async function detectConflictOperation(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const revertHead = path.join(gitDir, 'REVERT_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  // Probe concurrently without blocking main: each WSL/UNC path can cost a 9p round trip.
  const [hasMergeHead, hasCherryPickHead, hasRebaseMergeDir, hasRebaseApplyDir, hasRevertHead] =
    await Promise.all(
      [mergeHead, cherryPickHead, rebaseMergeDir, rebaseApplyDir, revertHead].map(pathExists)
    )
  const hasRebaseDir = hasRebaseMergeDir || hasRebaseApplyDir

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  if (hasRevertHead) {
    return 'revert'
  }
  return 'unknown'
}

/** Treat inaccessible paths as absent without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function abortMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['merge', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export async function abortRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}
