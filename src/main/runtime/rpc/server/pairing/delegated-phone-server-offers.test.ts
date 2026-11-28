// A phone a desktop relays may mint its own pairing with the server; it must never widen the
// server's listener (STA-2370), and revoking the desktop must revoke that pairing too.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingOffer } from '../../../../../shared/remote-runtime/pairing/pairing'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { createDelegatedPhoneServerOffer } from './delegated-phone-server-offers'

const RELAY_HOST_ID = 'relayHostId00001'
const NOW = 1_800_000_000_000
const INVITE_EXPIRES_AT = NOW + 60_000

describe('a relayed phone minting its own server pairing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pairs through Relay on a loopback server without widening it, chained to the desktop', async () => {
    // Only Date: the offer schema checks invite expiry against now; server timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-delegated-phone-offer-'))
    // Unpinned and loopback, as the desktop app's own server is until LAN pairing widens it.
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://director.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 1,
          relayHostId: RELAY_HOST_ID,
          inviteToken: 'A'.repeat(43),
          e2eeFraming: 2,
          inviteExpiresAt: INVITE_EXPIRES_AT
        },
        binding: {
          relayHostId: RELAY_HOST_ID,
          relayDeviceId,
          ownerIdentityKey: 'owner',
          inviteExpiresAt: INVITE_EXPIRES_AT
        }
      }),
      onDeviceRevokeQueued: () => {},
      getEndpoints: async () => {
        throw new Error('unused')
      },
      provisionRelay: async () => {
        throw new Error('unused')
      }
    })
    const registry = server.getDeviceRegistry()!
    const desktop = registry.addDevice('desktop', 'runtime', 'this-computer')
    registry.updateLastSeen(desktop.deviceId)
    const [relayed] = registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone', name: 'Pixel via Mac' }
    ])
    try {
      const lanOnly = await createDelegatedPhoneServerOffer(
        server,
        relayed!,
        { connectionMode: 'local-only' },
        async () => null
      )
      expect(lanOnly).toMatchObject({ available: false, reason: 'no_route' })

      const offer = await createDelegatedPhoneServerOffer(
        server,
        relayed!,
        { connectionMode: 'automatic' },
        async () => null
      )
      expect(offer).toMatchObject({ available: true, connectionMode: 'automatic' })
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')

      const pairedDeviceId = offer.available
        ? decodePairingOffer(offer.pairingUrl)?.pairedDeviceId
        : undefined
      const minted = registry.getDevice(pairedDeviceId ?? '')
      expect(minted).toMatchObject({
        name: 'Pixel via Mac',
        scope: 'mobile',
        pairingReach: 'this-computer',
        createdByDeviceId: relayed!.deviceId
      })

      expect(server.revokeRuntimeAccess(desktop.deviceId)).toBe(true)
      expect(registry.getDevice(minted!.deviceId)).toBeNull()

      // A request still in flight when its row was revoked leaves no offer the cascade can't reach.
      const late = await createDelegatedPhoneServerOffer(
        server,
        relayed!,
        { connectionMode: 'automatic' },
        async () => null
      )
      expect(late).toMatchObject({ available: false, reason: 'revoked' })
      expect(registry.listDevices().filter((device) => device.scope === 'mobile')).toEqual([])
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
