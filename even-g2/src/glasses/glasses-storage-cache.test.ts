import { describe, expect, it, vi } from 'vitest'
import { GlassesStorageCache } from './glasses-storage-cache'
import type { GlassesBridge } from './glasses-bridge'

function fakeBridge(initial: Record<string, string> = {}): GlassesBridge {
  const store = new Map(Object.entries(initial))
  return {
    createStartUpPage: vi.fn(),
    rebuildPage: vi.fn(),
    upgradeText: vi.fn(),
    shutDownPage: vi.fn(),
    getDeviceSnapshot: vi.fn(),
    onDeviceStatusChanged: vi.fn(),
    onRawEvent: vi.fn(),
    getStoredValue: vi.fn(async (key: string) => store.get(key) ?? ''),
    setStoredValue: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return true
    })
  } as unknown as GlassesBridge
}

describe('GlassesStorageCache', () => {
  it('read-through: a miss calls the bridge once and caches the result', async () => {
    const bridge = fakeBridge({ theme: 'dark' })
    const cache = new GlassesStorageCache(bridge)

    expect(await cache.get('theme')).toBe('dark')
    expect(await cache.get('theme')).toBe('dark')
    expect(bridge.getStoredValue).toHaveBeenCalledTimes(1)
  })

  it('write-through: set() writes to the bridge before updating the cache', async () => {
    const bridge = fakeBridge()
    const cache = new GlassesStorageCache(bridge)

    const ok = await cache.set('theme', 'light')

    expect(ok).toBe(true)
    expect(bridge.setStoredValue).toHaveBeenCalledWith('theme', 'light')
    expect(await cache.get('theme')).toBe('light')
    // get() after a successful set must be served from cache, not another bridge read.
    expect(bridge.getStoredValue).not.toHaveBeenCalled()
  })

  it('does not update the cache when the bridge write fails', async () => {
    const bridge = fakeBridge({ theme: 'dark' })
    bridge.setStoredValue = vi.fn(async () => false)
    const cache = new GlassesStorageCache(bridge)

    const ok = await cache.set('theme', 'light')

    expect(ok).toBe(false)
    expect(await cache.get('theme')).toBe('dark')
  })

  it("'' means absent: getStoredValue returning '' for a missing key round-trips as ''", async () => {
    const bridge = fakeBridge()
    const cache = new GlassesStorageCache(bridge)

    expect(await cache.get('missing')).toBe('')
    expect(cache.hasCached('missing')).toBe(false)
  })

  it("remove() writes '' through the bridge and marks the key absent", async () => {
    const bridge = fakeBridge({ theme: 'dark' })
    const cache = new GlassesStorageCache(bridge)
    await cache.get('theme')

    await cache.remove('theme')

    expect(bridge.setStoredValue).toHaveBeenCalledWith('theme', '')
    expect(await cache.get('theme')).toBe('')
    expect(cache.hasCached('theme')).toBe(false)
  })

  it('hasCached is true only for a cached non-empty value', async () => {
    const bridge = fakeBridge({ theme: 'dark' })
    const cache = new GlassesStorageCache(bridge)

    expect(cache.hasCached('theme')).toBe(false)
    await cache.get('theme')
    expect(cache.hasCached('theme')).toBe(true)
  })

  it('invalidate forces the next get() to read through again', async () => {
    const bridge = fakeBridge({ theme: 'dark' })
    const cache = new GlassesStorageCache(bridge)
    await cache.get('theme')

    cache.invalidate('theme')
    await cache.get('theme')

    expect(bridge.getStoredValue).toHaveBeenCalledTimes(2)
  })
})
