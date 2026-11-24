import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitConflictOperation } from '../../../../shared/git/status/git-status-types'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../git-read-cache-invalidation'
import { runWithGitWorktreeOperationLock } from '../../../../shared/git/worktrees/git-worktree-operation-lock'
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
  // Queued Abort runs once in this worktree after any Orca operation already holding the lane.
  await runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
    runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(['rebase', '--abort'], {
        ...gitOptionsForWorktree(worktreePath, options),
        terminationBarrier: true
      })
    )
  )
}

// Git 2.55 reworded "Applying autostash resulted in conflicts"; match both.
export const AUTOSTASH_REAPPLY_CONFLICT =
  /Applying autostash resulted in conflicts|local changes are stashed, however applying them\s+resulted in conflicts|could not apply autostash/i

/** Git refuses to rebase over tracked changes unless rebase.autoStash is on. */
export async function readRebaseAutoStash(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--bool', '--get', '--default=false', 'rebase.autoStash'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}
