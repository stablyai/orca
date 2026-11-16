import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RuntimeMobileFilePathSearchCache,
  type RuntimeMobileFilePathInventory
} from './mobile-path-search'

const TTL_MS = 30_000

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 6; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// Loaded CI may defer weak-reference clearing beyond one GC round.
async function collectUntil(released: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !released(); attempt++) {
    await collect()
  }
}

function inventory(path: string): RuntimeMobileFilePathInventory {
  return { paths: [path], totalCount: 1, truncated: false }
}

async function rememberPaths(cache: RuntimeMobileFilePathSearchCache): Promise<WeakRef<string[]>> {
  const paths = Array.from({ length: 20_000 }, (_, index) => `src/project/${index}/file.ts`)
  await cache.get('ssh-host:workspace', async () => ({
    paths,
    totalCount: paths.length,
    truncated: false
  }))
  return new WeakRef(paths)
}

describe('mobile file path inventory expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('releases the full idle inventory at its existing deadline', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
    const retained = await rememberPaths(cache)
    vi.advanceTimersByTime(TTL_MS - 1)
    await collect()
    expect(retained.deref()).toBeDefined()

    vi.advanceTimersByTime(1)
    await collectUntil(() => retained.deref() === undefined)
    expect(retained.deref() === undefined).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await expect(cache.get('ssh-host:workspace', async () => inventory('new.ts'))).resolves.toEqual(
      inventory('new.ts')
    )
  })

  it('allows the cache owner and inventory to be collected before expiry', async () => {
    async function releaseOwner() {
      const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
      return { owner: new WeakRef(cache), paths: await rememberPaths(cache) }
    }
    const retired = await releaseOwner()
    expect(vi.getTimerCount()).toBe(1)
    await collectUntil(
      () => retired.owner.deref() === undefined && retired.paths.deref() === undefined
    )
    expect(retired.owner.deref() === undefined).toBe(true)
    expect(retired.paths.deref() === undefined).toBe(true)
    vi.advanceTimersByTime(TTL_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels evicted timers and ignores a retired callback after the same key reloads', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const cache = new RuntimeMobileFilePathSearchCache(1, TTL_MS)
    await cache.get('a', async () => inventory('old.ts'))
    const retired = timeout.mock.calls[0]?.[0]
    if (typeof retired !== 'function') {
      throw new Error('Expected the original expiry callback')
    }
    vi.advanceTimersByTime(1000)
    await cache.get('b', async () => inventory('other.ts'))
    await cache.get('a', async () => inventory('replacement.ts'))
    expect(vi.getTimerCount()).toBe(1)
    const calls = timeout.mock.calls.length
    retired()
    expect(timeout).toHaveBeenCalledTimes(calls)
    await expect(cache.get('a', async () => inventory('unexpected.ts'))).resolves.toMatchObject(
      inventory('replacement.ts')
    )
    vi.advanceTimersByTime(TTL_MS)
    expect(vi.getTimerCount()).toBe(0)
  })
})
