import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  loadMobileRelayHostRoutingState,
  resetMobileRelayHostOverlayStoreForTests,
  saveMobileRelayHostRouting
} from './mobile-relay-host-overlay-store'
import type { MobileRelayHostOverlay } from './mobile-relay-host-overlay'

const STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
const RELAY = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
const RELAY_ONLY_OVERLAY: MobileRelayHostOverlay = {
  v: 2,
  hostId: 'host-1',
  endpoints: [
    {
      id: 'relay-primary',
      kind: 'relay',
      url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
    }
  ],
  relayHostId: RELAY.relayHostId,
  relay: RELAY
}
// What builds before the relay-routing split wrote: a copy of the row's address beside the relay.
const LEGACY_OVERLAY: MobileRelayHostOverlay = {
  ...RELAY_ONLY_OVERLAY,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.10:6768' },
    ...RELAY_ONLY_OVERLAY.endpoints
  ]
}

// Freeze the shipped overlay schema to prove older builds still accept written records.

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

  it('ignores a direct address an older build stored and drops it on the next routing write', async () => {
    stored = JSON.stringify([LEGACY_OVERLAY])

    await expect(loadMobileRelayHostRoutingState(new Set(['host-1']))).resolves.toEqual({
      relays: new Map([['host-1', RELAY]]),
      orphanHostIds: []
    })
    await expect(saveMobileRelayHostRouting('host-1', RELAY)).resolves.toBe(true)
    expect(JSON.parse(stored!)).toEqual([RELAY_ONLY_OVERLAY])
  })
})
