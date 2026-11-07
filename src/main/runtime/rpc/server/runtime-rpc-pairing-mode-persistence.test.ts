import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './pairing/device-registry'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { SimulatedMobileE2EEV2Peer } from '../../mobile-cloud-relay/simulated-mobile-e2ee-v2-peer'
import type { MobileSocketTransport, MobileSocketTransportMetadata } from '../mobile-socket-wiring'
import { AuthenticatedSourceRecorder, readNetworkSourcePolicy } from './network-source-policy-store'
import {
  waitForWsClose,
  authenticateMobileWsSession,
  sendEncryptedWsRequest,
  createEncryptedWsResponseReader
} from './runtime-rpc-mobile-ws-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
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
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

class SourcePolicySocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send = vi.fn((data: string | Buffer) => this.sent.push(data))
  readonly close = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This transport-edge double supplies OPEN, readyState, bufferedAmount, send, close, and EventEmitter methods consumed by the real E2EE wiring.
  readonly ws = this as unknown as WebSocket
}

/** Fakes only the transport edge; the started server owns authentication and readiness. */
class SourcePolicyTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }

  receive(socket: SourcePolicySocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), socket.ws)
  }

  disconnect(socket: SourcePolicySocket): void {
    this.closeHandler?.(null, socket.ws, false)
  }
}

describe('OrcaRuntimeRpcServer', () => {
  it('persists local-only pairing and rejects unavailable Iroh without Relay', async () => {
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
      await expect(
        server.createMobilePairingOffer({
          address: '100.64.1.20',
          connectionMode: 'iroh'
        })
      ).resolves.toMatchObject({ available: false, reason: 'iroh_unavailable' })
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
      // Changing local-only policy must mint a new token; an already-shown QR cannot silently gain anywhere access.
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
      // Same-mode remints from converging windows must not rotate using each other's tokens.
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
        transport: { transport: 'direct', sourceClass: 'loopback' }
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

  it('records public sources only after direct authentication through server-owned wiring', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const note = vi.spyOn(AuthenticatedSourceRecorder.prototype, 'note')
    const disconnects: (() => void)[] = []

    try {
      await server.start()
      const registry = server.getDeviceRegistry()
      const wiring = server.getMobileSocketWiring()
      const keypair = server.getE2EEKeypair()
      if (!registry || !wiring || !keypair) {
        throw new Error('Mobile socket wiring unavailable')
      }

      /** Drives real E2EEv2 admission without replacing the lifecycle's readiness callback. */
      function authenticate(metadata: MobileSocketTransportMetadata, deviceToken: string) {
        const socket = new SourcePolicySocket()
        const transport = new SourcePolicyTransport()
        const detach = wiring!.attachTransport(transport, () => metadata)
        disconnects.push(() => {
          socket.close()
          transport.disconnect(socket)
          detach()
        })
        const peer = new SimulatedMobileE2EEV2Peer(
          nacl.box.keyPair(),
          keypair!.publicKey,
          metadata.transport === 'relay' ? metadata.relayHostId : null
        )
        transport.receive(socket, JSON.stringify(peer.hello))
        expect(peer.acceptReady(JSON.parse(String(socket.sent[0])))).toBe(true)
        expect(note).not.toHaveBeenCalled()
        expect(readNetworkSourcePolicy(userDataPath)).toEqual({})
        transport.receive(
          socket,
          peer.sealText(
            JSON.stringify({
              type: 'e2ee_auth',
              v: 2,
              transcriptHashB64: peer.transcriptHashB64,
              deviceToken
            })
          )
        )
        return { socket, peer }
      }

      const rejected = registry.addDevice('Rejected phone', 'mobile')
      const failed = authenticate(
        { transport: 'direct', sourceClass: 'public' },
        `${rejected.token}-invalid`
      )
      expect(failed.socket.close).toHaveBeenCalledWith(4001, 'Unauthorized')
      expect(registry.getDevice(rejected.deviceId)).toMatchObject({ lastSeenAt: 0 })
      expect(registry.getDevice(rejected.deviceId)?.lastSourceClass).toBeUndefined()
      expect(note).not.toHaveBeenCalled()
      expect(readNetworkSourcePolicy(userDataPath)).toEqual({})

      const iroh = registry.addDevice('Iroh phone', 'mobile')
      expect(registry.setMobilePairingConnectionMode(iroh.deviceId, 'iroh')).toBe(true)
      registry.updateLastSeen(iroh.deviceId, undefined, 'legacy')
      expect(registry.getDevice(iroh.deviceId)?.legacyE2EEAuthAt).toBeGreaterThan(0)
      const relay = registry.addDevice('Relay phone', 'mobile')
      const direct = registry.addDevice('Direct phone', 'mobile')
      // Public policy is sticky, so direct success must follow the negative recorder cases.
      const cases: [typeof direct, MobileSocketTransportMetadata][] = [
        [iroh, { transport: 'iroh' }],
        [
          relay,
          {
            transport: 'relay',
            relayHostId: 'AbCdEf0123_-xyZ9',
            relayDeviceId: relay.deviceId,
            basisConnId: 'connection-1',
            credentialKind: 'invite'
          }
        ],
        [direct, { transport: 'direct', sourceClass: 'public' }]
      ]
      for (const [device, metadata] of cases) {
        const { socket, peer } = authenticate(metadata, device.token)
        expect(socket.close).not.toHaveBeenCalled()
        const acknowledgement = peer.openText(String(socket.sent[1]))
        expect(acknowledgement).not.toBeNull()
        expect(JSON.parse(acknowledgement!)).toMatchObject({ type: 'e2ee_authenticated', v: 2 })
        const row = registry.getDevice(device.deviceId)
        expect(row?.lastSeenAt).toBeGreaterThan(0)
        expect(row?.legacyE2EEAuthAt).toBeUndefined()
        if (metadata.transport === 'direct') {
          expect(row?.lastSourceClass).toBe('public')
          expect(note).toHaveBeenCalledExactlyOnceWith('public')
          expect(readNetworkSourcePolicy(userDataPath)).toEqual({ allowPublicSources: true })
        } else {
          expect(row?.lastSourceClass).toBeUndefined()
          expect(note).not.toHaveBeenCalled()
          expect(readNetworkSourcePolicy(userDataPath)).toEqual({})
        }
      }
    } finally {
      try {
        for (const disconnect of disconnects) {
          disconnect()
        }
      } finally {
        note.mockRestore()
        try {
          await server.stop()
        } finally {
          rmSync(userDataPath, { recursive: true, force: true })
        }
      }
    }
  })

  it('mints iroh key-dial offers without advertising a stale LAN endpoint or relay', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const endpointId = 'c'.repeat(64)
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      irohBindEndpoint: async () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The double supplies the endpoint operations consumed by IrohTransport.
        endpoint: {
          online: async () => {},
          acceptNext: async () => null,
          close: async () => {},
          id: () => ({ toString: () => endpointId })
        } as never,
        endpointId
      })
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
        connectionMode: 'iroh'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(offer.connectionMode).toBe('iroh')
      expect(createPairingRelay).not.toHaveBeenCalled()
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed).toEqual(
        expect.objectContaining({
          scope: 'mobile',
          endpoint: `iroh://${endpointId}`,
          iroh: { endpointId }
        })
      )
      expect(parsed).not.toHaveProperty('relay')
      expect(server.getDeviceRegistry()?.getMobilePairingConnectionMode(offer.deviceId)).toBe(
        'iroh'
      )
      const reloaded = new DeviceRegistry(userDataPath)
      expect(reloaded.getMobilePairingConnectionMode(offer.deviceId)).toBe('iroh')
      expect(reloaded.validateToken(parsed!.deviceToken)?.deviceId).toBe(offer.deviceId)
      expect(
        server.setMobileRelayBinding(offer.deviceId, {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId: offer.deviceId,
          ownerIdentityKey: 'user\0profile\0org'
        })
      ).toBe(false)

      vi.spyOn(server, 'getWebSocketEndpoint').mockReturnValue(null)
      await expect(
        server.createMobilePairingOffer({ connectionMode: 'iroh' })
      ).resolves.toMatchObject({
        available: true,
        endpoint: `iroh://${endpointId}`
      })
    } finally {
      await server.stop()
    }
  })
})
