import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getAllKeys: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  loadMobileRelayHostOverlays,
  MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES,
  MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS,
  removeMobileRelayHostOverlays,
  resetMobileRelayHostOverlayStoreForTests,
  saveMobileRelayHostOverlay
} from './mobile-relay-host-overlay-store'
import type { MobileRelayHostOverlay } from './mobile-relay-host-overlay'

const STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
const V3_KEY_PREFIX = 'orca:mobile-relay:host-overlay:v3:'
const OVERLAY: MobileRelayHostOverlay = {
  v: 2,
  hostId: 'host-1',
  routeOrder: 1,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.10:6768' },
    {
      id: 'relay-primary',
      kind: 'relay',
      url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
    }
  ],
  relayHostId: 'AbCdEf0123_-xyZ9',
  relay: {
    v: 1,
    directorUrl: 'https://relay.onorca.dev',
    cellUrl: 'https://relay-c1.onorca.dev',
    assignmentEpoch: 7,
    relayHostId: 'AbCdEf0123_-xyZ9',
    e2eeFraming: 2
  }
}

describe('mobile relay host overlay store', () => {
  let stored: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileRelayHostOverlayStoreForTests()
    stored = new Map()
    asyncStorage.getAllKeys.mockImplementation(async () => [...stored.keys()])
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
  })

  it('round-trips metadata in an isolated per-host namespace', async () => {
    await saveMobileRelayHostOverlay(OVERLAY)

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(
      new Map([['host-1', OVERLAY]])
    )
    expect(asyncStorage.setItem).toHaveBeenCalledWith(`${V3_KEY_PREFIX}host-1`, expect.any(String))
  })

  it('never overlays or resurrects a host whose legacy base was removed', async () => {
    stored.set(STORAGE_KEY, JSON.stringify([OVERLAY]))

    await expect(loadMobileRelayHostOverlays(new Set())).resolves.toEqual(new Map())
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(JSON.parse(stored.get(STORAGE_KEY)!)).toEqual([OVERLAY])
  })

  it('writes a per-host overlay without rewriting unreadable legacy storage', async () => {
    stored.set(STORAGE_KEY, '{')

    await expect(saveMobileRelayHostOverlay(OVERLAY)).resolves.toBeUndefined()
    expect(stored.get(`${V3_KEY_PREFIX}host-1`)).toBe(JSON.stringify(OVERLAY))
    expect(stored.get(STORAGE_KEY)).toBe('{')
  })

  it('removes requested overlays in one storage write', async () => {
    const second = { ...OVERLAY, hostId: 'host-2' }
    stored.set(STORAGE_KEY, JSON.stringify([OVERLAY, second]))

    await expect(removeMobileRelayHostOverlays(['host-1', 'host-missing'])).resolves.toBeUndefined()

    await vi.waitFor(() => expect(JSON.parse(stored.get(STORAGE_KEY)!)).toEqual([second]))
    expect(asyncStorage.removeItem).toHaveBeenCalledTimes(2)
  })

  it('skips the storage write when no requested overlay exists', async () => {
    stored.set(STORAGE_KEY, JSON.stringify([OVERLAY]))

    await expect(removeMobileRelayHostOverlays(['host-missing'])).resolves.toBeUndefined()

    await vi.waitFor(() => expect(asyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY))
    expect(stored.get(STORAGE_KEY)).toBe(JSON.stringify([OVERLAY]))
  })

  it('loads a pending per-host snapshot without waiting for its native write', async () => {
    let finishWrite!: () => void
    asyncStorage.setItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            stored.set(`${V3_KEY_PREFIX}host-1`, JSON.stringify(OVERLAY))
            resolve()
          }
        })
    )
    const saving = saveMobileRelayHostOverlay(OVERLAY)
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'))

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(
      new Map([['host-1', OVERLAY]])
    )

    finishWrite()
    await saving
    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(
      new Map([['host-1', OVERLAY]])
    )
  })

  it('loads known hosts directly when global key enumeration fails', async () => {
    stored.set(`${V3_KEY_PREFIX}host-1`, JSON.stringify(OVERLAY))
    asyncStorage.getAllKeys.mockRejectedValueOnce(new Error('enumeration unavailable'))

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(
      new Map([['host-1', OVERLAY]])
    )
    expect(asyncStorage.getItem).toHaveBeenCalledWith(`${V3_KEY_PREFIX}host-1`)
  })

  it('starts independent known-host reads concurrently', async () => {
    const second = { ...OVERLAY, hostId: 'host-2' }
    let finishFirst!: () => void
    let finishSecond!: () => void
    asyncStorage.getItem.mockImplementation((key: string) => {
      if (key === STORAGE_KEY) {
        return Promise.resolve(null)
      }
      return new Promise<string | null>((resolve) => {
        if (key === `${V3_KEY_PREFIX}host-1`) {
          finishFirst = () => resolve(JSON.stringify(OVERLAY))
        } else {
          finishSecond = () => resolve(JSON.stringify(second))
        }
      })
    })

    const loading = loadMobileRelayHostOverlays(new Set(['host-1', 'host-2']))
    await vi.waitFor(() => expect(finishSecond).toBeTypeOf('function'))
    finishSecond()
    finishFirst()

    await expect(loading).resolves.toEqual(
      new Map([
        ['host-1', OVERLAY],
        ['host-2', second]
      ])
    )
  })

  it('does not revive a stale legacy overlay when the per-host read fails', async () => {
    stored.set(STORAGE_KEY, JSON.stringify([OVERLAY]))
    asyncStorage.getItem.mockImplementationOnce(async (key: string) => stored.get(key) ?? null)
    asyncStorage.getItem.mockRejectedValueOnce(new Error('per-host read unavailable'))

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(new Map())
  })

  it('does not let one stalled host overlay block another host', async () => {
    const second = { ...OVERLAY, hostId: 'host-2' }
    let finishFirst!: () => void
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      if (key === `${V3_KEY_PREFIX}host-1`) {
        await new Promise<void>((resolve) => {
          finishFirst = () => {
            stored.set(key, value)
            resolve()
          }
        })
        return
      }
      stored.set(key, value)
    })

    const savingFirst = saveMobileRelayHostOverlay(OVERLAY)
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    await expect(saveMobileRelayHostOverlay(second)).resolves.toBeUndefined()

    expect(stored.get(`${V3_KEY_PREFIX}host-2`)).toBe(JSON.stringify(second))
    finishFirst()
    await savingFirst
  })

  it('accepts the exact legacy count and isolates v3 writes from one over', async () => {
    const exact = Array.from({ length: MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES }, (_, index) => ({
      ...OVERLAY,
      hostId: `host-${index}`
    }))
    stored.set(STORAGE_KEY, JSON.stringify(exact))
    const hostIds = new Set(exact.map(({ hostId }) => hostId))
    expect((await loadMobileRelayHostOverlays(hostIds)).size).toBe(
      MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES
    )

    stored.set(STORAGE_KEY, JSON.stringify([...exact, { ...OVERLAY, hostId: 'one-over' }]))
    await expect(loadMobileRelayHostOverlays(hostIds)).resolves.toEqual(new Map())
    // V3 is per-host, so unreadable legacy state cannot block a bounded write.
    await expect(saveMobileRelayHostOverlay(OVERLAY)).resolves.toBeUndefined()
    expect(stored.get(STORAGE_KEY)).toBe(
      JSON.stringify([...exact, { ...OVERLAY, hostId: 'one-over' }])
    )
  })

  it('ignores an oversized legacy payload without rewriting it', async () => {
    const oversized = 'x'.repeat(MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS + 1)
    stored.set(STORAGE_KEY, oversized)

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(new Map())
    await expect(saveMobileRelayHostOverlay(OVERLAY)).resolves.toBeUndefined()
    expect(stored.get(STORAGE_KEY)).toBe(oversized)
  })
})
