import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import {
  waitForWsClose,
  authenticateMobileWsSession,
  sendEncryptedWsRequest,
  createEncryptedWsResponseReader
} from './runtime-rpc-mobile-ws-test-harness'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('persists local-only pairing and never mints or later binds Relay', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const createPairingRelay = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay,
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(parsePairingCode(offer.pairingUrl)).not.toHaveProperty('relay')
      expect(createPairingRelay).not.toHaveBeenCalled()
      expect(offer.connectionMode).toBe('local-only')
      expect(server.getDeviceRegistry()?.getMobilePairingConnectionMode(offer.deviceId)).toBe(
        'local-only'
      )
      expect(
        server.setMobileRelayBinding(offer.deviceId, {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId: offer.deviceId,
          ownerIdentityKey: 'user\0profile\0org'
        })
      ).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('normalizes untrusted pairing modes to automatic at the runtime boundary', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
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
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const offer = await server.createMobilePairingOffer({
        connectionMode: 'renderer-controlled-value' as never
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(offer.connectionMode).toBe('automatic')
      expect(server.getDeviceRegistry()?.getMobilePairingConnectionMode(offer.deviceId)).toBe(
        'automatic'
      )
    } finally {
      await server.stop()
    }
  })

  it('revokes and rotates a pending Relay code when switching it to local-only', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
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

    await server.start()
    try {
      const anywhere = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(anywhere.available).toBe(true)
      if (!anywhere.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const local = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(local.available).toBe(true)
      if (!local.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(local.deviceId).not.toBe(anywhere.deviceId)
      expect(server.getDeviceRegistry()?.getDevice(anywhere.deviceId)).toBeNull()
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
      expect(parsePairingCode(local.pairingUrl)).not.toHaveProperty('relay')
    } finally {
      await server.stop()
    }
  })

  it('rotates a pending local-only code when switching it back to Anywhere', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
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
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const local = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(local.available).toBe(true)
      if (!local.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const anywhere = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(anywhere.available).toBe(true)
      if (!anywhere.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      // Why: a QR displayed under the local-only pledge must not become an
      // anywhere-capable credential; the policy switch mints a fresh token.
      expect(anywhere.deviceId).not.toBe(local.deviceId)
      expect(server.getDeviceRegistry()?.getDevice(local.deviceId)).toBeNull()
      expect(anywhere.connectionMode).toBe('automatic')
      expect(parsePairingCode(anywhere.pairingUrl)).toHaveProperty('relay')
    } finally {
      await server.stop()
    }
  })

  it('reuses the pending token when the requested mode is unchanged', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
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

    await server.start()
    try {
      const first = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(first.available).toBe(true)
      if (!first.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      // Why: a same-mode remint (e.g. two windows converging after a
      // preference sync) must not race rotations off each other's token.
      const second = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(second.available).toBe(true)
      if (!second.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(second.deviceId).toBe(first.deviceId)
      expect(onDeviceRevokeQueued).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('records cloud cleanup before rotating or deleting the local mobile credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const registryPresence: boolean[] = []
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
      onDeviceRevokeQueued: (item) => {
        registryPresence.push(server.getDeviceRegistry()?.getDevice(item.relayDeviceId) !== null)
      },
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      expect(first.available).toBe(true)
      if (!first.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const second = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        rotate: true
      })
      expect(second.available).toBe(true)
      if (!second.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(server.getDeviceRegistry()?.getDevice(first.deviceId)).toBeNull()
      await expect(server.revokeMobileDevice(second.deviceId)).resolves.toBe(true)
      expect(server.getDeviceRegistry()?.getDevice(second.deviceId)).toBeNull()
      expect(registryPresence).toEqual([true, true])
    } finally {
      await server.stop()
    }
  })

  it('binds pairing RPC providers to the immutable authenticated socket context', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const getEndpoints = vi.fn().mockResolvedValue({ v: 1, relay: null })
    const provisionRelay = vi.fn().mockResolvedValue({
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: Date.now() + 60_000
    })
    server.setMobileRelayPairingProvider({
      createPairingRelay: vi.fn(),
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints,
      provisionRelay
    })

    await server.start()
    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const session = await authenticateMobileWsSession(offer.pairingUrl)
      const responses = createEncryptedWsResponseReader(session)
      sendEncryptedWsRequest(session, {
        id: 'endpoints-1',
        method: 'pairing.getEndpoints',
        params: { installReqId: 'status-1' }
      })
      await expect(responses.next('endpoints-1')).resolves.toMatchObject({
        ok: true,
        result: { v: 1, relay: null }
      })
      sendEncryptedWsRequest(session, {
        id: 'provision-1',
        method: 'pairing.provisionRelay',
        params: { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) }
      })
      await expect(responses.next('provision-1')).resolves.toMatchObject({ ok: true })

      const [endpointContext, endpointParams] = getEndpoints.mock.calls[0]!
      expect(endpointContext).toEqual({
        deviceId: offer.deviceId,
        connectionId: expect.any(String),
        transport: { transport: 'direct' }
      })
      expect(endpointParams).toEqual({ installReqId: 'status-1' })
      expect(provisionRelay).toHaveBeenCalledWith(endpointContext, {
        reqId: 'install-1',
        newResumeTokenHash: 'A'.repeat(43)
      })
      responses.dispose()
      session.ws.close()
      await waitForWsClose(session.ws)
    } finally {
      await server.stop()
    }
  })
})
