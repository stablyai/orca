// A server pinned to loopback (SSH-managed orcad) must pair phones through Relay without ever widening its bind (STA-2370).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { createOwnerPairingOffer } from './pairing-offer-requests'

const RELAY_HOST_ID = 'relayHostId00001'
const NOW = 1_800_000_000_000
const INVITE_EXPIRES_AT = NOW + 60_000

describe('pairing a loopback-pinned server', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints a Relay-only mobile offer and keeps listening on loopback', async () => {
    // Only Date: the offer schema checks invite expiry against now; server timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
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
    const noRouteLookup = async (): Promise<null> => null
    try {
      const relayOffer = await createOwnerPairingOffer(
        server,
        { scope: 'mobile', relay: true },
        noRouteLookup
      )
      // Automatic mode is returned only after the Relay invite was minted and bound.
      expect(relayOffer).toMatchObject({
        available: true,
        endpoint: null,
        connectionMode: 'automatic'
      })

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
