// A server pinned to loopback (SSH-managed orcad) must pair phones through Relay without ever widening its bind (STA-2370).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../../../../shared/remote-runtime/pairing/pairing'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { createOwnerPairingOffer } from './pairing-offer-requests'

const RELAY_HOST_ID = 'relayHostId00001'

describe('pairing a loopback-pinned server', () => {
  it('mints a Relay-only mobile offer and keeps listening on loopback', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-loopback-pinned-pairing-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '127.0.0.1'
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
          inviteExpiresAt: Date.now() + 60_000
        },
        binding: {
          relayHostId: RELAY_HOST_ID,
          relayDeviceId,
          ownerIdentityKey: 'owner',
          inviteExpiresAt: Date.now() + 60_000
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
    const noRouteLookup = async (): Promise<null> => null
    try {
      const relayOffer = await createOwnerPairingOffer(
        server,
        { scope: 'mobile', relay: true },
        noRouteLookup
      )
      expect(relayOffer).toMatchObject({ available: true, endpoint: null })
      if (!relayOffer.available) {
        throw new Error('unreachable')
      }
      expect(parsePairingCode(relayOffer.pairingUrl)?.relay?.relayHostId).toBe(RELAY_HOST_ID)

      // Without Relay there is no direct route to advertise, so LAN-only refuses instead of widening.
      const lanOffer = await createOwnerPairingOffer(server, { scope: 'mobile' }, noRouteLookup)
      expect(lanOffer).toMatchObject({ available: false, reason: 'invalid_advertised_endpoint' })

      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
