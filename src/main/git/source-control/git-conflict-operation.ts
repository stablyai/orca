import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitConflictOperation } from '../../../shared/git-status-types'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { runWithGitReadCacheInvalidation } from './git-read-cache-invalidation'
import { resolveGitDir } from './resolve-git-dir'

// Why: the git-status → existsSync race can miss a transient HEAD; fall back to 'unknown' for one poll cycle.
// Why: detect rebase from rebase-merge/ or rebase-apply/ dirs (persist all steps), not REBASE_HEAD (partial, lingers → stale badge).
export async function detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  // Why async and concurrent: this runs on every status poll, and on a WSL/UNC git dir each
  // probe is a 9p round trip — four of them synchronously blocked the Electron main thread.
  const [hasMergeHead, hasCherryPickHead, hasRebaseMergeDir, hasRebaseApplyDir] = await Promise.all(
    [mergeHead, cherryPickHead, rebaseMergeDir, rebaseApplyDir].map(pathExists)
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
  return 'unknown'
}

/** Mirrors existsSync: any failure to reach the path reads as absent, never as a throw. */
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
