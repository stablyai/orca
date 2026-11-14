import { BoundedMap } from '../../../shared/bounded-map'
import type { GitDiffResult } from '../../../shared/git/diff/git-diff-compare-types'
import type { GitLineStats } from '../../../shared/git/status/git-uncommitted-line-stats'
import {
  canProveUnchangedByStamp,
  isDiffStampClockSkewed,
  type WorktreeDiffStamp
} from './input-stamps/worktree-diff-stamp'

/** Reuse diffs only with matching input stamps; decline unknown, recent, failed or mutation-overlapped reads. */

// Bound retained characters as well as entries: each diff can contain two entire files.
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
  /** Future mtimes also increment racyWrites; count them separately to expose clock skew. */
  clockSkewedWrites: number
  /** Store declined because a mutation invalidated the cache while the read ran. */
  invalidatedDuringRead: number
  entries: number
  retainedCharacters: number
}

export type SettledDiffCacheLimits<T> = {
  maxEntries: number
  maxCharacters: number
  maxEntryCharacters: number
  characterCount: (result: T) => number
}

export const FILE_DIFF_CACHE_LIMITS: SettledDiffCacheLimits<GitDiffResult> = {
  maxEntries: MAX_SETTLED_DIFF_CACHE_ENTRIES,
  maxCharacters: MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS,
  maxEntryCharacters: MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS,
  characterCount: (result) => result.originalContent.length + result.modifiedContent.length
}

/** Status numstat passes: two per worktree, each a path-keyed count map. */
export const NUMSTAT_CACHE_LIMITS: SettledDiffCacheLimits<Map<string, GitLineStats>> = {
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
}

type CacheEntry<T> = { stamp: string; result: T; characters: number }

export class SettledDiffCache<T> {
  private readonly entries: BoundedMap<string, CacheEntry<T>>
  private readonly characterCount: (result: T) => number
  private generation = 0
  private hits = 0
  private misses = 0
  private unprovable = 0
  private stores = 0
  private racyWrites = 0
  private clockSkewedWrites = 0
  private invalidatedDuringRead = 0

  constructor(limits: SettledDiffCacheLimits<T>) {
    this.characterCount = limits.characterCount
    this.entries = new BoundedMap<string, CacheEntry<T>>({
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxCharacters,
      maxEntryBytes: limits.maxEntryCharacters,
      sizeOf: (entry) => entry.characters
    })
  }

  /** Capture before reading; a generation change prevents publishing across a mutation. */
  beginRead(): number {
    return this.generation
  }

  /** For results whose stamp inputs are derived from the result itself; skips stats and LRU order. */
  peek(key: string): T | undefined {
    return this.entries.peek(key)?.result
  }

  get(key: string, stamp: WorktreeDiffStamp | null): T | undefined {
    if (!stamp) {
      this.unprovable += 1
      return undefined
    }
    const entry = this.entries.get(key)
    if (!entry || entry.stamp !== stamp.value) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    return entry.result
  }

  set(key: string, stamp: WorktreeDiffStamp | null, result: T, readGeneration: number): void {
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
    const characters = this.characterCount(result)
    if (this.entries.set(key, { stamp: stamp.value, result, characters })) {
      this.stores += 1
    }
  }

  clear(): void {
    this.entries.clear()
    // Prevent pre-mutation reads from repopulating the cleared cache.
    this.generation += 1
  }

  /** Expose counters to distinguish unstable stamps and miss storms from cold starts. */
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
