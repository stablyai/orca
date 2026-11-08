import type { GitDiffResult } from '../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusResult } from '../../../shared/git/status/git-status-types'
import type { GitLineStats } from '../../../shared/git/status/git-uncommitted-line-stats'
import { InFlightPromiseDedupe } from '../../../shared/in-flight-promise-dedupe'
import { clearGitStatusLineStatsCache } from '../../../shared/git/status/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git/status/git-branch-line-total'
import { GitStatusReadLeaseOwner } from '../../../shared/git/status/git-status-read-lease-owner'
import { invalidateGitUpstreamStatusReads } from './upstream'
import { clearSubmodulePathsCache } from './submodule-paths'
import { resolvedUpstreamNameCache } from './resolved-upstream-name-cache'
import { FILE_DIFF_CACHE_LIMITS, SettledDiffCache } from './settled-diff-cache'

export const gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult>()

/** Settled diff results, valid only while their stamped git state holds. */
export const settledDiffCache = new SettledDiffCache(FILE_DIFF_CACHE_LIMITS)

/** Settled status numstat passes, keyed per worktree and area. */
export const settledNumstatCache = new SettledDiffCache<Map<string, GitLineStats>>({
  maxEntries: 256,
  maxCharacters: 8_000_000,
  maxEntryCharacters: 1_000_000,
  // Paths dominate; the counts are a few digits each.
  characterCount: (stats) => {
    let characters = 0
    for (const filePath of stats.keys()) {
      characters += filePath.length + 16
    }
    return characters
  }
})

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

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Invalidate again: reads started during the mutation can also be stale.
    invalidateGitReadCaches()
  }
}
