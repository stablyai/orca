import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { requestMobilePairingOffer } from '../../pairing-offer-requests'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { authenticateMobileWs, waitForWsClose } from './runtime-rpc-mobile-ws-test-harness'

function createRelayServer(userDataPath: string): OrcaRuntimeRpcServer {
  const server = new OrcaRuntimeRpcServer({
    methods: [],
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  server.setMobileRelayPairingProvider({
    createPairingRelay: async (relayDeviceId) => ({
      relay: {
        v: 1,
        directorUrl: 'https://relay.example.com',
        cellUrl: 'https://cell.example.com',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'A'.repeat(43),
        inviteExpiresAt: Date.parse('2026-11-07T12:01:00Z'),
        e2eeFraming: 2
      },
      binding: {
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId,
        ownerIdentityKey: 'user\0profile\0org'
      }
    }),
    onDeviceRevokeQueued: vi.fn(),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn()
  })
  return server
}

describe('Relay pairing without a direct address', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
    onTestFinished(() => {
      vi.useRealTimers()
    })
  })

  it('keeps the listener on loopback through pairing, authentication and relaunch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    onTestFinished(() => rmSync(userDataPath, { recursive: true, force: true }))
    const server = createRelayServer(userDataPath)
    await server.start()
    try {
      const offer = await requestMobilePairingOffer(server, {
        address: '192.168.1.24',
        localPath: false,
        offerTtlMs: 600_000
      })
      if (!offer.available) {
        throw new Error('Relay pairing unavailable')
      }
      expect(offer.endpoint).toBeNull()
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
      const phone = await authenticateMobileWs(offer.pairingUrl)
      phone.close()
      await waitForWsClose(phone)
    } finally {
      await server.stop()
    }

    const relaunched = createRelayServer(userDataPath)
    await relaunched.start()
    try {
      expect(new URL(relaunched.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
    } finally {
      await relaunched.stop()
    }
  })

  it('revokes a network-reach code across expiry policies while preserving LAN-only pairing', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    onTestFinished(() => rmSync(userDataPath, { recursive: true, force: true }))
    const server = createRelayServer(userDataPath)
    await server.start()
    try {
      const withLocalPath = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      const relayOnly = await server.createMobilePairingOffer({
        address: null,
        offerTtlMs: 600_000
      })
      if (!withLocalPath.available || !relayOnly.available) {
        throw new Error('Relay pairing unavailable')
      }
      const previousCode = parsePairingCode(withLocalPath.pairingUrl)
      const currentCode = parsePairingCode(relayOnly.pairingUrl)
      if (!previousCode || !currentCode) {
        throw new Error('Invalid pairing code')
      }
      const registry = server.getDeviceRegistry()!
      expect(registry.validateToken(previousCode.deviceToken)?.deviceId ?? null).toBeNull()
      expect(registry.validateToken(currentCode.deviceToken)?.deviceId).toBe(relayOnly.deviceId)
      expect(
        server
          .getRelayRevokeOutbox()
          .pendingFor('user\0profile\0org', 'AbCdEf0123_-xyZ9')
          .map((item) => item.relayDeviceId)
      ).toEqual([withLocalPath.deviceId])

      const lanOnly = await requestMobilePairingOffer(server, {
        address: '100.64.1.20',
        connectionMode: 'local-only',
        localPath: false
      })
      if (!lanOnly.available) {
        throw new Error('LAN pairing unavailable')
      }
      expect(lanOnly.connectionMode).toBe('local-only')
      expect(new URL(lanOnly.endpoint!).hostname).toBe('100.64.1.20')
    } finally {
      await server.stop()
    }
  })
})
