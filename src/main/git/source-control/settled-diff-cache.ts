import { BoundedMap } from '../../../shared/bounded-map'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import {
  canProveUnchangedByStamp,
  isDiffStampClockSkewed,
  type WorktreeDiffStamp
} from './worktree-diff-stamp'

/**
 * Diff results that survive their read, guarded by a stamp of the git state they
 * were built from.
 *
 * Why this is not a TTL: nothing here expires on a clock, so no window exists in
 * which a stale diff can be served. An entry is returned only when a freshly
 * taken stamp equals the one captured *before* the read that produced it, which
 * means no input moved from then until now. Everything else — an unprovable
 * stamp, a write too recent for its mtime to be conclusive, a read that failed
 * partway, a mutation that ran while the read was in flight — declines to cache
 * rather than risk it.
 */

// A diff result carries whole file contents on both sides, so an entry count alone bounds
// nothing: the real budget is characters, and one entry can legitimately be huge.
export const MAX_SETTLED_DIFF_CACHE_ENTRIES = 32
export const MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS = 1_000_000
export const MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS = 8_000_000

export type SettledDiffCacheStats = {
  hits: number
  /** Stamp was taken but no entry matched it. */
  misses: number
  /** No stamp could be taken, so the read could never be cached. */
  unprovable: number
  stores: number
  /** Store declined because a write was too recent for its mtime to be conclusive. */
  racyWrites: number
  /**
   * Subset of `racyWrites` where a component's mtime was in this host's future, so
   * the clocks disagree and the refusal will persist until they converge. A nonzero
   * count here means the cache is off for a reason no amount of idling will fix.
   */
  clockSkewedWrites: number
  /** Store declined because a mutation invalidated the cache while the read ran. */
  invalidatedDuringRead: number
  entries: number
  retainedCharacters: number
}

type CacheEntry = { stamp: string; result: GitDiffResult; characters: number }

export class SettledDiffCache {
  private readonly entries = new BoundedMap<string, CacheEntry>({
    maxEntries: MAX_SETTLED_DIFF_CACHE_ENTRIES,
    maxBytes: MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS,
    maxEntryBytes: MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS,
    sizeOf: (entry) => entry.characters
  })
  private generation = 0
  private hits = 0
  private misses = 0
  private unprovable = 0
  private stores = 0
  private racyWrites = 0
  private clockSkewedWrites = 0
  private invalidatedDuringRead = 0

  /**
   * Take before starting a read; hand back to `set`. A mutation that lands while
   * the read is in flight bumps the generation, and the store is refused — the
   * result describes pre-mutation state and must not outlive it.
   */
  beginRead(): number {
    return this.generation
  }

  get(key: string, stamp: WorktreeDiffStamp | null): GitDiffResult | undefined {
    if (!stamp) {
      this.unprovable += 1
      return undefined
    }
    // BoundedMap.get() already refreshes the LRU position.
    const entry = this.entries.get(key)
    if (!entry || entry.stamp !== stamp.value) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    return entry.result
  }

  set(
    key: string,
    stamp: WorktreeDiffStamp | null,
    result: GitDiffResult,
    readGeneration: number
  ): void {
    if (!stamp) {
      return
    }
    if (readGeneration !== this.generation) {
      this.invalidatedDuringRead += 1
      return
    }
    if (!canProveUnchangedByStamp(stamp)) {
      this.racyWrites += 1
      if (isDiffStampClockSkewed(stamp)) {
        this.clockSkewedWrites += 1
      }
      return
    }
    const characters = resultCharacterCount(result)
    if (this.entries.set(key, { stamp: stamp.value, result, characters })) {
      this.stores += 1
    }
  }

  clear(): void {
    this.entries.clear()
    // Why: bump so a read that started pre-mutation can't repopulate the invalidated cache.
    this.generation += 1
  }

  /**
   * Why exposed: a stamp that can never match — an inode or mtime the filesystem
   * reports unstably — looks exactly like having no cache at all. These counters
   * are what tells a miss storm apart from a cold start.
   */
  stats(): SettledDiffCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      unprovable: this.unprovable,
      stores: this.stores,
      racyWrites: this.racyWrites,
      clockSkewedWrites: this.clockSkewedWrites,
      invalidatedDuringRead: this.invalidatedDuringRead,
      entries: this.entries.size,
      retainedCharacters: this.entries.retainedBytes
    }
  }

  resetStatsForTests(): void {
    this.hits = 0
    this.misses = 0
    this.unprovable = 0
    this.stores = 0
    this.racyWrites = 0
    this.clockSkewedWrites = 0
    this.invalidatedDuringRead = 0
  }
}

function resultCharacterCount(result: GitDiffResult): number {
  return result.originalContent.length + result.modifiedContent.length
}
