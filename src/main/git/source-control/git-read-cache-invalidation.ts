import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitStatusResult } from '../../../shared/git-status-types'
import { InFlightPromiseDedupe } from '../../../shared/in-flight-promise-dedupe'
import { clearGitStatusLineStatsCache } from '../../../shared/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git-branch-line-total'
import { GitStatusReadLeaseOwner } from '../git-status-read-lease-owner'
import { invalidateGitUpstreamStatusReads } from '../upstream'
import { clearSubmodulePathsCache } from './submodule-paths'
import { resolvedUpstreamNameCache } from './resolved-upstream-name-cache'
import { SettledDiffCache } from './settled-diff-cache'

export const gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult>()

/** Settled diff results, valid only while their stamped git state holds. */
export const settledDiffCache = new SettledDiffCache()

export const statusReadLeaseOwner = new GitStatusReadLeaseOwner<GitStatusResult>()

// Why: clear every in-flight git read cache; clearing only some would let a post-mutation
// getStatus() join a pre-mutation read and publish it as current.
export function invalidateGitReadCaches(): void {
  gitDiffReadDedupe.clear()
  settledDiffCache.clear()
  statusReadLeaseOwner.invalidate()
  invalidateGitBranchLineTotalInFlight()
  invalidateGitUpstreamStatusReads()
  clearGitStatusLineStatsCache()
  clearSubmodulePathsCache()
  resolvedUpstreamNameCache.clear()
}

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Why: a read that started mid-mutation can be stale too, so invalidate again after.
    invalidateGitReadCaches()
  }
}
