import { describe, expect, it, vi } from 'vitest'
import {
  type RuntimeMobileFilePathInventory,
  RuntimeMobileFilePathSearchCache
} from './mobile-path-search'

describe('RuntimeMobileFilePathSearchCache', () => {
  it('reuses a live entry and evicts the oldest key at capacity', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    const load = vi.fn(async (path: string) => ({
      paths: [path],
      totalCount: 1,
      truncated: false
    }))

    await cache.get('a', () => load('a'), 0)
    await cache.get('a', () => load('a-again'), 50)
    await cache.get('b', () => load('b'), 50)
    await cache.get('c', () => load('c'), 50)
    await cache.get('a', () => load('a-reloaded'), 50)

    expect(load.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c', 'a-reloaded'])
  })

  it('reloads an unevicted key once its TTL has elapsed', async () => {
    // Isolate TTL expiry from capacity eviction.
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    const load = vi.fn(async (path: string) => ({ paths: [path], totalCount: 1, truncated: false }))

    await cache.get('a', () => load('a'), 0)
    await cache.get('a', () => load('a-live'), 50)
    await cache.get('a', () => load('a-expired'), 150)

    expect(load.mock.calls.map((call) => call[0])).toEqual(['a', 'a-expired'])
  })

  it('coalesces concurrent cold loads for the same worktree', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(2, 100)
    let resolveLoad: (value: RuntimeMobileFilePathInventory) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<RuntimeMobileFilePathInventory>((resolve) => {
          resolveLoad = resolve
        })
    )

    const first = cache.get('a', load, 0)
    const second = cache.get('a', load, 0)
    expect(load).toHaveBeenCalledOnce()

    resolveLoad({ paths: ['a'], totalCount: 1, truncated: false })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { paths: ['a'], totalCount: 1, truncated: false },
      { paths: ['a'], totalCount: 1, truncated: false }
    ])
  })

  it('starts the TTL when a slow inventory becomes usable', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const cache = new RuntimeMobileFilePathSearchCache(2, 100)
      let resolveLoad: (value: RuntimeMobileFilePathInventory) => void = () => {}
      const load = vi.fn(
        () =>
          new Promise<RuntimeMobileFilePathInventory>((resolve) => {
            resolveLoad = resolve
          })
      )
      const first = cache.get('slow-ssh', load)
      vi.setSystemTime(200)
      resolveLoad({ paths: ['a'], totalCount: 1, truncated: false })
      await first

      await cache.get('slow-ssh', load)
      expect(load).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
