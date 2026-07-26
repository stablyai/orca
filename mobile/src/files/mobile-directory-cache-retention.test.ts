import { describe, expect, it } from 'vitest'
import type { DirectoryCache, DirectoryState } from './file-tree'
import {
  MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES,
  parseBoundedMobileDirectoryEntries,
  removeEvictedExpandedPaths,
  retainMobileDirectoryState
} from './mobile-directory-cache-retention'

function state(name: string, lastAccess: number): DirectoryState {
  return { entries: [{ name, isDirectory: false }], lastAccess }
}

describe('mobile directory cache retention', () => {
  it('keeps the cache bounded across an unlimited sequence of visited directories', () => {
    let cache: DirectoryCache = { '': state('root', 0) }

    for (let index = 1; index <= MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES * 3; index++) {
      const result = retainMobileDirectoryState(
        cache,
        `dir-${index}`,
        state(`file-${index}`, index),
        new Set()
      )
      expect(result.admitted).toBe(true)
      cache = result.cache
    }

    expect(Object.keys(cache)).toHaveLength(MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES)
    expect(cache['']).toBeDefined()
    expect(cache['dir-1']).toBeUndefined()
    expect(cache[`dir-${MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES * 3}`]).toBeDefined()
  })

  it('evicts a collapsed branch before an older expanded branch', () => {
    const cache: DirectoryCache = {
      '': state('root', 0),
      expanded: state('expanded', 1),
      collapsed: state('collapsed', 2)
    }

    const result = retainMobileDirectoryState(
      cache,
      'new',
      state('new', 3),
      new Set(['expanded']),
      { directories: 3, entries: 100, retainedBytes: 10_000 }
    )

    expect(result.cache.expanded).toBeDefined()
    expect(result.cache.collapsed).toBeUndefined()
    expect(result.evictedPaths).toEqual(['collapsed'])
  })

  it('evicts old content when aggregate entry retention reaches its cap', () => {
    const cache: DirectoryCache = {
      '': state('root', 0),
      old: state('old', 1)
    }

    const result = retainMobileDirectoryState(cache, 'new', state('new', 2), new Set(), {
      directories: 10,
      entries: 2,
      retainedBytes: 10_000
    })

    expect(result.cache.old).toBeUndefined()
    expect(result.cache.new).toBeDefined()
  })

  it('evicts old content when aggregate retained bytes reach their cap', () => {
    const cache: DirectoryCache = {
      '': state('root', 0),
      old: state('x'.repeat(100), 1)
    }

    const result = retainMobileDirectoryState(cache, 'new', state('new', 2), new Set(), {
      directories: 10,
      entries: 100,
      retainedBytes: 300
    })

    expect(result.cache.old).toBeUndefined()
    expect(result.cache.new).toBeDefined()
  })

  it('collapses expanded descendants whose cached branch was evicted', () => {
    expect([...removeEvictedExpandedPaths(new Set(['src', 'src/lib', 'docs']), ['src'])]).toEqual([
      'docs'
    ])
  })

  it('rejects malformed listings instead of retaining untrusted response shapes', () => {
    expect(() => parseBoundedMobileDirectoryEntries([{ name: 'src' }])).toThrow(
      'invalid folder listing'
    )
  })
})
