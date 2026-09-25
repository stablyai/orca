import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  loadMobileRelayHostOverlayState,
  removeMobileRelayHostOverlays,
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

// Frozen copy of the overlay schema shipped builds parse with (relay endpoint schema is shared);
// they drop a record it rejects.
const ShippedOverlaySchema = z
  .object({
    v: z.literal(2),
    hostId: z.string().min(1),
    endpoints: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            kind: z.enum(['lan', 'tailscale', 'relay']),
            url: z.string().min(1).max(2048)
          })
          .strict()
      )
      .min(1)
      .max(16),
    relayHostId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16}$/)
      .optional(),
    relay: MobileRelayEndpointSchema.optional()
  })
  .strict()
  .superRefine((overlay, context) => {
    if ((overlay.relayHostId === undefined) !== (overlay.relay === undefined)) {
      context.addIssue({ code: 'custom', message: 'Relay identity and endpoint must coexist' })
      return
    }
    if (overlay.relay && overlay.relay.relayHostId !== overlay.relayHostId) {
      context.addIssue({ code: 'custom', message: 'Relay host identity mismatch' })
    }
    const relayEndpointCount = overlay.endpoints.filter(({ kind }) => kind === 'relay').length
    if (relayEndpointCount !== (overlay.relay ? 1 : 0)) {
      context.addIssue({ code: 'custom', message: 'Expected exactly one relay endpoint' })
    }
  })

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

  it('round-trips relay routing in a namespace legacy builds do not rewrite', async () => {
    await expect(saveMobileRelayHostRouting('host-1', RELAY)).resolves.toBe(true)

    await expect(loadMobileRelayHostOverlayState(new Set(['host-1']))).resolves.toEqual({
      relays: new Map([['host-1', RELAY]]),
      orphanHostIds: []
    })
    expect(JSON.parse(stored!)).toEqual([RELAY_ONLY_OVERLAY])
  })

  it('writes a record the shipped overlay schema still accepts', async () => {
    await saveMobileRelayHostRouting('host-1', RELAY)

    const [record] = JSON.parse(stored!)
    expect(ShippedOverlaySchema.safeParse(record).success).toBe(true)
  })

  it('ignores a direct address an older build stored and drops it on the next routing write', async () => {
    stored = JSON.stringify([LEGACY_OVERLAY])

    await expect(loadMobileRelayHostOverlayState(new Set(['host-1']))).resolves.toEqual({
      relays: new Map([['host-1', RELAY]]),
      orphanHostIds: []
    })
    await expect(saveMobileRelayHostRouting('host-1', RELAY)).resolves.toBe(true)
    expect(JSON.parse(stored!)).toEqual([RELAY_ONLY_OVERLAY])
  })

  it('never overlays or resurrects a host whose legacy base was removed', async () => {
    stored = JSON.stringify([LEGACY_OVERLAY])

    await expect(loadMobileRelayHostOverlayState(new Set())).resolves.toEqual({
      relays: new Map(),
      orphanHostIds: ['host-1']
    })
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(JSON.parse(stored)).toEqual([LEGACY_OVERLAY])
  })

  it('refuses to overwrite unreadable overlay storage', async () => {
    stored = '{'

    await expect(saveMobileRelayHostRouting('host-1', RELAY)).rejects.toThrow(/unreadable/)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('removes requested overlays in one storage write', async () => {
    const second = { ...RELAY_ONLY_OVERLAY, hostId: 'host-2' }
    stored = JSON.stringify([RELAY_ONLY_OVERLAY, second])

    await expect(removeMobileRelayHostOverlays(['host-1', 'host-missing'])).resolves.toBeUndefined()

    expect(JSON.parse(stored!)).toEqual([second])
    expect(asyncStorage.getItem).toHaveBeenCalledOnce()
    expect(asyncStorage.setItem).toHaveBeenCalledOnce()
  })

  it('skips the storage write when no requested overlay exists', async () => {
    stored = JSON.stringify([RELAY_ONLY_OVERLAY])

    await expect(removeMobileRelayHostOverlays(['host-missing'])).resolves.toBeUndefined()

    expect(asyncStorage.getItem).toHaveBeenCalledOnce()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })
})
