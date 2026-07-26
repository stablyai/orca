import { describe, expect, it } from 'vitest'
import {
  buildRepositoryRefCacheKey,
  REPOSITORY_REF_CACHE_KEY_MAX_BYTES,
  REPOSITORY_REF_CACHE_MAX_ENTRIES,
  REPOSITORY_REF_CACHE_VALUE_MAX_BYTES,
  RepositoryRefCache
} from './repository-ref-cache'

describe('repository ref cache bounds', () => {
  it('admits an exact-boundary UTF-8 key and rejects one byte over', () => {
    expect(
      buildRepositoryRefCacheKey(['a'.repeat(REPOSITORY_REF_CACHE_KEY_MAX_BYTES - 1), ''])
    ).not.toBeNull()
    expect(
      buildRepositoryRefCacheKey(['a'.repeat(REPOSITORY_REF_CACHE_KEY_MAX_BYTES), ''])
    ).toBeNull()
  })

  it('measures multibyte keys by bytes', () => {
    expect(
      buildRepositoryRefCacheKey(['😀'.repeat(REPOSITORY_REF_CACHE_KEY_MAX_BYTES / 4)])
    ).not.toBeNull()
    expect(
      buildRepositoryRefCacheKey(['😀'.repeat(REPOSITORY_REF_CACHE_KEY_MAX_BYTES / 4 + 1)])
    ).toBeNull()
  })

  it('retains exact-boundary values and skips oversized values', () => {
    const cache = new RepositoryRefCache<{ value: string }>()
    const exactKey = buildRepositoryRefCacheKey(['exact'])
    const oversizedKey = buildRepositoryRefCacheKey(['oversized'])
    const exact = 'a'.repeat(REPOSITORY_REF_CACHE_VALUE_MAX_BYTES)
    const oversized = 'a'.repeat(REPOSITORY_REF_CACHE_VALUE_MAX_BYTES + 1)

    cache.remember(exactKey, { value: exact }, [exact])
    cache.remember(oversizedKey, { value: oversized }, [oversized])

    expect(cache.get(exactKey)).toEqual({ found: true, value: { value: exact } })
    expect(cache.get(oversizedKey)).toEqual({ found: false })
  })

  it('bounds entry count and refreshes hits before LRU eviction', () => {
    const cache = new RepositoryRefCache<{ value: number }>()
    for (let index = 0; index < REPOSITORY_REF_CACHE_MAX_ENTRIES; index += 1) {
      cache.remember(`key-${index}`, { value: index }, [])
    }
    expect(cache.get('key-0')).toEqual({ found: true, value: { value: 0 } })
    cache.remember('new-key', { value: -1 }, [])

    expect(cache.size).toBe(REPOSITORY_REF_CACHE_MAX_ENTRIES)
    expect(cache.get('key-0').found).toBe(true)
    expect(cache.get('key-1')).toEqual({ found: false })
  })

  it('never retains an inadmissible key', () => {
    const cache = new RepositoryRefCache<{ value: number }>()
    cache.remember(null, { value: 1 }, [])
    expect(cache.size).toBe(0)
  })
})
