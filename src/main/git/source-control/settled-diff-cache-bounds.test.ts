import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../../shared/git/diff/git-diff-compare-types'
import { MAX_SETTLED_DIFF_CACHE_RESULT_CHARACTERS, SettledDiffCache } from './settled-diff-cache'
import type { WorktreeDiffStamp } from './worktree-diff-stamp'

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
