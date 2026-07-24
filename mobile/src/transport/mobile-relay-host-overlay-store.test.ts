import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
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
const OVERLAY: MobileRelayHostOverlay = {
  v: 2,
  hostId: 'host-1',
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
  let stored: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileRelayHostOverlayStoreForTests()
    stored = null
    asyncStorage.getItem.mockImplementation(async (key: string) =>
      key === STORAGE_KEY ? stored : null
    )
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      if (key === STORAGE_KEY) {
        stored = value
      }
    })
  })

  it('round-trips v2 metadata in a namespace legacy builds do not rewrite', async () => {
    await saveMobileRelayHostOverlay(OVERLAY)

    await expect(loadMobileRelayHostOverlays(new Set(['host-1']))).resolves.toEqual(
      new Map([['host-1', OVERLAY]])
    )
    expect(asyncStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String))
  })

  it('never overlays or resurrects a host whose legacy base was removed', async () => {
    stored = JSON.stringify([OVERLAY])

    await expect(loadMobileRelayHostOverlays(new Set())).resolves.toEqual(new Map())
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(JSON.parse(stored)).toEqual([OVERLAY])
  })

  it('refuses to overwrite unreadable overlay storage', async () => {
    stored = '{'

    await expect(saveMobileRelayHostOverlay(OVERLAY)).rejects.toThrow(/unreadable/)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('removes requested overlays in one storage write', async () => {
    const second = { ...OVERLAY, hostId: 'host-2' }
    stored = JSON.stringify([OVERLAY, second])

    await expect(removeMobileRelayHostOverlays(['host-1', 'host-missing'])).resolves.toBeUndefined()

    expect(JSON.parse(stored!)).toEqual([second])
    expect(asyncStorage.getItem).toHaveBeenCalledOnce()
    expect(asyncStorage.setItem).toHaveBeenCalledOnce()
  })

  it('skips the storage write when no requested overlay exists', async () => {
    stored = JSON.stringify([OVERLAY])

    await expect(removeMobileRelayHostOverlays(['host-missing'])).resolves.toBeUndefined()

    expect(asyncStorage.getItem).toHaveBeenCalledOnce()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('accepts the exact overlay count and refuses to overwrite one over', async () => {
    const exact = Array.from({ length: MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES }, (_, index) => ({
      ...OVERLAY,
      hostId: `host-${index}`
    }))
    stored = JSON.stringify(exact)
    const hostIds = new Set(exact.map(({ hostId }) => hostId))
    expect((await loadMobileRelayHostOverlays(hostIds)).size).toBe(
      MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES
    )

    stored = JSON.stringify([...exact, { ...OVERLAY, hostId: 'one-over' }])
    await expect(saveMobileRelayHostOverlay(OVERLAY)).rejects.toThrow(/unreadable/)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('rejects an oversized overlay payload before parsing', async () => {
    stored = 'x'.repeat(MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS + 1)

    await expect(saveMobileRelayHostOverlay(OVERLAY)).rejects.toThrow(/unreadable/)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })
})
