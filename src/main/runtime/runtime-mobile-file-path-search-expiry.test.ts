import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  RuntimeMobileFilePathSearchCache,
  type RuntimeMobileFilePathInventory
} from './runtime-mobile-file-path-search'

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
    await collect()
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
    await collect()
    expect(retired.owner.deref() === undefined).toBe(true)
    expect(retired.paths.deref() === undefined).toBe(true)
    vi.advanceTimersByTime(TTL_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps cache hits through the original deadline without extending it', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
    const load = vi.fn(async () => inventory('file.ts'))
    await cache.get('workspace', load)
    vi.advanceTimersByTime(TTL_MS - 1)
    await cache.get('workspace', load)
    expect(load).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(vi.getTimerCount()).toBe(0)
    await cache.get('workspace', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('starts expiry when a slow SSH load settles and shares its pending request', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
    let resolveLoad: (value: RuntimeMobileFilePathInventory) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<RuntimeMobileFilePathInventory>((resolve) => {
          resolveLoad = resolve
        })
    )
    const first = cache.get('ssh-host:workspace', load)
    const second = cache.get('ssh-host:workspace', load)
    vi.advanceTimersByTime(TTL_MS * 2)
    expect(vi.getTimerCount()).toBe(0)
    resolveLoad(inventory('file.ts'))
    await Promise.all([first, second])
    expect(load).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(TTL_MS - 1)
    await cache.get('ssh-host:workspace', load)
    expect(load).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
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

  it('preserves caller-controlled explicit clocks without arming wall-clock timers', async () => {
    const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
    const load = vi.fn(async () => inventory('file.ts'))
    await cache.get('workspace', load, 0)
    vi.advanceTimersByTime(TTL_MS * 2)
    await cache.get('workspace', load, TTL_MS - 1)
    expect(load).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await cache.get('workspace', load, TTL_MS)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('bounds delay after a backward wall-clock jump without evicting fresh paths', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const cache = new RuntimeMobileFilePathSearchCache(8, TTL_MS)
    const load = vi.fn(async () => inventory('file.ts'))
    await cache.get('workspace', load)
    vi.setSystemTime(-MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(TTL_MS)
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS)
    await cache.get('workspace', load)
    expect(load).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    expect(vi.getTimerCount()).toBe(0)
  })
})
