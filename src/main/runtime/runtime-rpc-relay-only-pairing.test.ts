import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

function createRelayServer(
  userDataPath: string,
  onDeviceRevokeQueued = vi.fn()
): OrcaRuntimeRpcServer {
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
        inviteExpiresAt: Date.now() + 60_000,
        e2eeFraming: 2
      },
      binding: {
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId,
        ownerIdentityKey: 'user\0profile\0org'
      }
    }),
    onDeviceRevokeQueued,
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn()
  })
  return server
}

const listenerHostOf = (server: OrcaRuntimeRpcServer): string | null | undefined =>
  (server['activeTransports'] as unknown[]).find(
    (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
  )?.resolvedHost

describe('Relay pairing without a direct address', () => {
  it('keeps the listener on loopback when minting and after the phone has connected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = createRelayServer(userDataPath)
    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({ address: null })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('Relay pairing unavailable')
      }
      expect(offer.connectionMode).toBe('automatic')
      expect(listenerHostOf(server)).toBe('127.0.0.1')
      server.getDeviceRegistry()?.updateLastSeen(offer.deviceId)
    } finally {
      await server.stop()
    }

    const relaunched = createRelayServer(userDataPath)
    await relaunched.start()
    try {
      expect(listenerHostOf(relaunched)).toBe('127.0.0.1')
    } finally {
      await relaunched.stop()
    }
  })

  it('revokes and rotates a pending code that advertised a direct address', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const onDeviceRevokeQueued = vi.fn()
    const server = createRelayServer(userDataPath, onDeviceRevokeQueued)
    await server.start()
    try {
      const withLocalPath = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      const relayOnly = await server.createMobilePairingOffer({ address: null })
      if (!withLocalPath.available || !relayOnly.available) {
        throw new Error('Relay pairing unavailable')
      }
      expect(relayOnly.deviceId).not.toBe(withLocalPath.deviceId)
      const registry = server.getDeviceRegistry()
      expect(registry?.getDevice(withLocalPath.deviceId)).toBeNull()
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      // The reused LAN-reach row would widen every later launch once this phone connects.
      expect(registry?.getDevice(relayOnly.deviceId)?.pairingReach).toBe('this-computer')
    } finally {
      await server.stop()
    }
  })
})
