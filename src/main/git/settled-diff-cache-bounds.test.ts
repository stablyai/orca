import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import {
  MAX_SETTLED_DIFF_CACHE_ENTRIES,
  MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS,
  MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS,
  SettledDiffCache
} from './source-control/settled-diff-cache'
import type { WorktreeDiffStamp } from './source-control/worktree-diff-stamp'

function settledStamp(value: string): WorktreeDiffStamp {
  // Old enough that the racy-write margin is satisfied.
  return { value, newestMtimeMs: Date.now() - 60_000, capturedAtMs: Date.now() }
}

function diffOfSize(characters: number): GitDiffResult {
  return {
    kind: 'text',
    originalContent: '',
    modifiedContent: 'x'.repeat(characters),
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

describe('SettledDiffCache bounds', () => {
  it('evicts the least recently used entry past the entry cap', () => {
    const cache = new SettledDiffCache()
    for (let index = 0; index <= MAX_SETTLED_DIFF_CACHE_ENTRIES; index += 1) {
      cache.set(`key-${index}`, settledStamp(`stamp-${index}`), diffOfSize(1), cache.beginRead())
    }

    expect(cache.stats().entries).toBe(MAX_SETTLED_DIFF_CACHE_ENTRIES)
    expect(cache.get('key-0', settledStamp('stamp-0'))).toBeUndefined()
    expect(
      cache.get(
        `key-${MAX_SETTLED_DIFF_CACHE_ENTRIES}`,
        settledStamp(`stamp-${MAX_SETTLED_DIFF_CACHE_ENTRIES}`)
      )
    ).toBeDefined()
  })

  it('keeps a re-read entry alive by refreshing its LRU position', () => {
    const cache = new SettledDiffCache()
    cache.set('hot', settledStamp('hot-stamp'), diffOfSize(1), cache.beginRead())
    for (let index = 0; index < MAX_SETTLED_DIFF_CACHE_ENTRIES; index += 1) {
      cache.get('hot', settledStamp('hot-stamp'))
      cache.set(`cold-${index}`, settledStamp(`cold-${index}`), diffOfSize(1), cache.beginRead())
    }

    expect(cache.get('hot', settledStamp('hot-stamp'))).toBeDefined()
  })

  // One entry can legitimately hold megabytes, so an entry count alone bounds nothing.
  it('holds total retained content under the character budget', () => {
    const cache = new SettledDiffCache()
    const chunk = MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS
    const needed = Math.ceil(MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS / chunk) + 2

    for (let index = 0; index < needed; index += 1) {
      cache.set(
        `key-${index}`,
        settledStamp(`stamp-${index}`),
        diffOfSize(chunk),
        cache.beginRead()
      )
    }

    expect(cache.stats().retainedCharacters).toBeLessThanOrEqual(
      MAX_SETTLED_DIFF_CACHE_TOTAL_CHARACTERS
    )
  })

  it('declines a single result larger than the per-entry cap', () => {
    const cache = new SettledDiffCache()

    cache.set(
      'huge',
      settledStamp('huge-stamp'),
      diffOfSize(MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS + 1),
      cache.beginRead()
    )

    expect(cache.stats().entries).toBe(0)
    expect(cache.stats().retainedCharacters).toBe(0)
  })

  it('releases retained characters when a key is overwritten', () => {
    const cache = new SettledDiffCache()
    cache.set('key', settledStamp('first'), diffOfSize(1_000), cache.beginRead())
    cache.set('key', settledStamp('second'), diffOfSize(10), cache.beginRead())

    expect(cache.stats().entries).toBe(1)
    expect(cache.stats().retainedCharacters).toBe(10)
    expect(cache.get('key', settledStamp('first'))).toBeUndefined()
    expect(cache.get('key', settledStamp('second'))).toBeDefined()
  })

  it('drops everything and refuses in-flight stores after a clear', () => {
    const cache = new SettledDiffCache()
    const readGeneration = cache.beginRead()
    cache.clear()
    cache.set('key', settledStamp('stamp'), diffOfSize(1), readGeneration)

    expect(cache.stats().entries).toBe(0)
    expect(cache.stats().invalidatedDuringRead).toBe(1)
  })
})

// Why (#15036 review): the margin compares this host's clock to mtimes the WSL guest
// wrote. A guest running ahead refuses every store for as long as the skew lasts, and
// without its own counter that is indistinguishable from a repo nobody has touched.
describe('settled diff cache clock skew', () => {
  const result: GitDiffResult = diffOfSize(10)

  it('counts a future-dated mtime separately from an ordinary racy write', () => {
    const cache = new SettledDiffCache()
    const now = Date.now()

    // Honestly fresh: written just now, margin not yet satisfied.
    cache.set(
      'fresh',
      { value: 'a', newestMtimeMs: now, capturedAtMs: now },
      result,
      cache.beginRead()
    )
    // Skewed: mtime in this host's future, which no local write can produce.
    cache.set(
      'skewed',
      { value: 'b', newestMtimeMs: now + 60_000, capturedAtMs: now },
      result,
      cache.beginRead()
    )

    const stats = cache.stats()
    expect(stats.racyWrites).toBe(2)
    expect(stats.clockSkewedWrites).toBe(1)
    expect(stats.stores).toBe(0)
  })

  it('does not flag a stamp whose components were all absent', () => {
    const cache = new SettledDiffCache()
    const now = Date.now()

    cache.set(
      'absent',
      { value: 'c', newestMtimeMs: Number.NEGATIVE_INFINITY, capturedAtMs: now },
      result,
      cache.beginRead()
    )

    expect(cache.stats().clockSkewedWrites).toBe(0)
  })
})
