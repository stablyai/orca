import type { GitDiffResult } from '../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusResult } from '../../../shared/git/status/git-status-types'
import { InFlightPromiseDedupe } from '../../../shared/in-flight-promise-dedupe'
import {
  clearGitStatusLineStatsCache,
  clearGitStatusLineStatsCacheKey,
  clearGitStatusLineStatsCacheKeysWhere
} from '../../../shared/git/status/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git/status/git-branch-line-total'
import { GitStatusReadLeaseOwner } from '../../../shared/git/status/git-status-read-lease-owner'
import { invalidateGitUpstreamStatusReads } from './upstream'
import { clearSubmodulePathsCache } from './submodule-paths'
import { resolvedUpstreamNameCache } from './resolved-upstream-name-cache'
import {
  getStatusLineStatsCacheKey,
  isStatusKeyForWorktreePath
} from './status-branch-line-total-input'
import {
  FILE_DIFF_CACHE_LIMITS,
  NUMSTAT_CACHE_LIMITS,
  SettledDiffCache
} from './settled-diff-cache'

export const gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult>()

/** Settled diff results, valid only while their stamped git state holds. */
export const settledDiffCache = new SettledDiffCache(FILE_DIFF_CACHE_LIMITS)

/** Settled status numstat passes, keyed per worktree and area. */
export const settledNumstatCache = new SettledDiffCache(NUMSTAT_CACHE_LIMITS)

export const statusReadLeaseOwner = new GitStatusReadLeaseOwner<GitStatusResult>()

// Clear every read cache so post-mutation calls cannot join stale pre-mutation reads.
export function invalidateGitReadCaches(): void {
  gitDiffReadDedupe.clear()
  settledDiffCache.clear()
  settledNumstatCache.clear()
  statusReadLeaseOwner.invalidate()
  invalidateGitBranchLineTotalInFlight()
  invalidateGitUpstreamStatusReads()
  clearGitStatusLineStatsCache()
  clearSubmodulePathsCache()
  resolvedUpstreamNameCache.clear()
}

// A change made outside Orca: later status reads must neither join a read begun before it nor reuse its line counts.
// `null` means the changed checkouts are unknown.
export function invalidateGitStatusReads(worktreePaths: readonly string[] | null): void {
  if (worktreePaths === null) {
    statusReadLeaseOwner.invalidate()
    clearGitStatusLineStatsCache()
    return
  }
  for (const worktreePath of worktreePaths) {
    // Any execution host: a Windows-path repo may read status through WSL Git.
    const forPath = (key: string): boolean => isStatusKeyForWorktreePath(key, worktreePath)
    statusReadLeaseOwner.invalidateWhere(forPath)
    clearGitStatusLineStatsCacheKeysWhere(forPath)
    // Also fences a first native count still in flight, which has no cache entry yet.
    clearGitStatusLineStatsCacheKey(getStatusLineStatsCacheKey(worktreePath))
  }
}

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Invalidate again: reads started during the mutation can also be stale.
    invalidateGitReadCaches()
  }
}
