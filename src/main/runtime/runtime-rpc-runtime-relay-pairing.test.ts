import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { MobileRelayPairingProvider } from './runtime-rpc/runtime-rpc-pairing-types'
import { parsePairingCode } from '../../shared/pairing'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const ownerIdentityKey = 'user\0profile\0org'
const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://cell.example.com',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'A'.repeat(43),
  inviteExpiresAt: Date.now() + 60_000,
  e2eeFraming: 2 as const
}

function relayProvider(
  overrides: Partial<MobileRelayPairingProvider> = {}
): MobileRelayPairingProvider {
  return {
    createPairingRelay: async (relayDeviceId) => ({
      relay,
      binding: {
        relayHostId: relay.relayHostId,
        relayDeviceId,
        ownerIdentityKey,
        inviteExpiresAt: relay.inviteExpiresAt
      }
    }),
    onDeviceRevokeQueued: vi.fn(),
    onDemandStateChanged: vi.fn(),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn(),
    ...overrides
  }
}

async function withServer(
  provider: MobileRelayPairingProvider | null,
  run: (server: OrcaRuntimeRpcServer) => Promise<void>
): Promise<void> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-relay-pairing-')),
    enableWebSocket: true,
    wsPort: 0
  })
  server.setMobileRelayPairingProvider(provider)
  await server.start()
  try {
    await run(server)
  } finally {
    await server.stop()
  }
}

describe('runtime-scoped Relay pairing', () => {
  it('mints a Relay link for the same grant while the direct link stays Relay-free', async () => {
    await withServer(relayProvider(), async (server) => {
      const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      if (!offer.available || !offer.relay.available) {
        throw new Error('expected a runtime Relay pairing offer')
      }

      const direct = parsePairingCode(offer.pairingUrl)
      // Why: clients that predate runtime Relay reject a runtime offer carrying `relay`.
      expect(direct).not.toHaveProperty('relay')
      expect(direct).toMatchObject({ scope: 'runtime', endpoint: offer.endpoint })

      const viaRelay = parsePairingCode(offer.relay.pairingUrl)
      expect(viaRelay).toEqual({
        ...direct,
        relay
      })
      expect(offer.relay.inviteExpiresAt).toBe(relay.inviteExpiresAt)
      const registry = server.getDeviceRegistry()
      expect(registry?.getDevice(offer.deviceId)).toMatchObject({
        scope: 'runtime',
        relayBinding: { relayDeviceId: offer.deviceId, inviteExpiresAt: relay.inviteExpiresAt }
      })
      expect(registry?.isRelayEnabled(offer.deviceId)).toBe(true)
    })
  })

  it('keeps the direct link and leaves the grant Relay-disabled when minting fails', async () => {
    const provider = relayProvider({
      createPairingRelay: vi.fn().mockRejectedValue(new Error('relay_control_not_active'))
    })
    await withServer(provider, async (server) => {
      const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      if (!offer.available) {
        throw new Error('expected the direct runtime pairing offer')
      }
      expect(offer.relay).toEqual({
        available: false,
        failure: expect.objectContaining({
          code: 'relay_control_not_active',
          stage: 'create_pairing_relay'
        })
      })
      expect(parsePairingCode(offer.pairingUrl)).toMatchObject({ scope: 'runtime' })
      expect(server.getDeviceRegistry()?.isRelayEnabled(offer.deviceId)).toBe(false)
    })
  })

  it('reports a missing Relay provider without dropping the direct link', async () => {
    await withServer(null, async (server) => {
      const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      expect(offer).toMatchObject({
        available: true,
        relay: { available: false, failure: { code: 'relay_provider_unavailable' } }
      })
    })
  })

  it('revoking a Relay-enabled runtime grant queues its cloud credential revoke', async () => {
    const provider = relayProvider()
    await withServer(provider, async (server) => {
      const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      if (!offer.available) {
        throw new Error('expected a runtime pairing offer')
      }

      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)

      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)).toBeNull()
      expect(provider.onDeviceRevokeQueued).toHaveBeenCalledWith(
        expect.objectContaining({ relayDeviceId: offer.deviceId, relayHostId: relay.relayHostId })
      )
      expect(server.getRelayRevokeOutbox().pendingFor(ownerIdentityKey, relay.relayHostId)).toEqual(
        [expect.objectContaining({ relayDeviceId: offer.deviceId })]
      )
      expect(provider.onDemandStateChanged).toHaveBeenCalled()
    })
  })

  it('revokes a direct-only runtime grant without a cloud revoke', async () => {
    const provider = relayProvider()
    await withServer(provider, async (server) => {
      const offer = server.createPairingOffer({ address: '100.64.1.20', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('expected a runtime pairing offer')
      }

      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)

      expect(provider.onDeviceRevokeQueued).not.toHaveBeenCalled()
      expect(server.getRelayRevokeOutbox().pendingFor(ownerIdentityKey, relay.relayHostId)).toEqual(
        []
      )
    })
  })

  it('a newer link revokes the Relay invite of the unused grant it replaces', async () => {
    const onDemandStateChanged = vi.fn()
    await withServer(relayProvider({ onDemandStateChanged }), async (server) => {
      const first = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      if (!first.available) {
        throw new Error('expected a runtime pairing offer')
      }
      onDemandStateChanged.mockClear()

      const next = server.createPairingOffer({
        address: '100.64.1.20',
        scope: 'runtime',
        rotate: true
      })

      expect(next).toMatchObject({ available: true })
      expect(server.getDeviceRegistry()?.getDevice(first.deviceId)).toBeNull()
      expect(server.getRelayRevokeOutbox().pendingFor(ownerIdentityKey, relay.relayHostId)).toEqual(
        [expect.objectContaining({ relayDeviceId: first.deviceId })]
      )
      expect(onDemandStateChanged).toHaveBeenCalled()
    })
  })
})
