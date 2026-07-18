import { describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from './types'
import { hostProfileFromPairingOffer } from './host-profile-from-pairing'
import { createMobileRelayPairingJournal } from './mobile-relay-pairing-journal'

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }))

const secondary = 'ws://100.64.1.20:6768'
const offer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  endpoints: ['ws://192.168.1.10:6768', secondary],
  deviceToken: 'device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
} satisfies PairingOffer

describe('pairing route-order compatibility', () => {
  it('ignores additive fallback fields without the opt-in marker', () => {
    const host = hostProfileFromPairingOffer({ id: 'host-1', name: 'Mac', offer })

    expect(host.endpoints).toEqual([{ id: 'direct-primary', kind: 'lan', url: offer.endpoint }])
    expect(host.routeOrder).toBeUndefined()
  })

  it('does not journal unmarked fallback fields for later reconnect', () => {
    const journal = createMobileRelayPairingJournal({
      offer: {
        ...offer,
        relay: {
          v: 1,
          directorUrl: 'https://relay.onorca.dev',
          cellUrl: 'https://relay-c1.onorca.dev',
          assignmentEpoch: 1,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
          inviteExpiresAt: Date.now() + 300_000,
          e2eeFraming: 2
        }
      },
      hostId: 'host-1',
      hostName: 'Mac',
      randomBytes: (length) => new Uint8Array(length).fill(length)
    })

    expect(journal.metadata.host.endpoints).toBeUndefined()
    expect(journal.metadata.host.relayPreferenceIndex).toBeUndefined()
    expect(journal.metadata.host.routeOrder).toBeUndefined()
  })

  it('persists fallbacks when route order is explicitly enabled', () => {
    const host = hostProfileFromPairingOffer({
      id: 'host-1',
      name: 'Mac',
      offer: { ...offer, routeOrder: 1 }
    })

    expect(host.endpoints?.map(({ url }) => url)).toEqual([offer.endpoint, secondary])
    expect(host.routeOrder).toBe(1)
  })
})
