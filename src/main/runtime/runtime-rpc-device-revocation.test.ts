import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { encodeDeviceProofMessage } from '../../shared/device-key-proof'
import { SimulatedMobileE2EEV2Peer } from './mobile-cloud-relay/simulated-mobile-e2ee-v2-peer'
import { OrcaRuntimeService } from './orca-runtime'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import { waitFor } from './runtime-rpc-test-harness'
import {
  connectWs,
  nextWsMessage,
  waitForWsClose,
  authenticateMobileWs
} from './runtime-rpc-mobile-ws-test-harness'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
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

async function authenticateKeyedWs(offer: PairingOffer, deviceId: string, key: nacl.SignKeyPair) {
  const ws = await connectWs(offer.endpoint)
  const peer = new SimulatedMobileE2EEV2Peer(
    nacl.box.keyPair(),
    Uint8Array.from(Buffer.from(offer.publicKeyB64, 'base64')),
    null
  )
  ws.send(JSON.stringify(peer.hello))
  expect(peer.acceptReady(JSON.parse(await nextWsMessage(ws)))).toBe(true)
  const transcriptHashB64 = peer.transcriptHashB64
  const proof = nacl.sign.detached(
    encodeDeviceProofMessage('auth', Buffer.from(transcriptHashB64, 'base64')),
    key.secretKey
  )
  ws.send(
    peer.sealText(
      JSON.stringify({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64,
        deviceId,
        deviceProofB64: Buffer.from(proof).toString('base64')
      })
    )
  )
  expect(JSON.parse(peer.openText(await nextWsMessage(ws))!)).toMatchObject({
    type: 'e2ee_authenticated'
  })
  return { ws, peer }
}

describe('OrcaRuntimeRpcServer', () => {
  it('cleans up pre-auth E2EE WebSocket state when the socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'mobile-test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const parsed = parsePairingCode(offer.pairingUrl)!
      const ws = await connectWs(parsed.endpoint)
      const mobileKeys = generateKeyPair()
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(mobileKeys.publicKey).toString('base64')
        })
      )
      expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })
      expect(server['mobileSocketWiring']?.channelCount).toBe(1)
      expect(server['mobileSocketWiring']?.connectionCount).toBe(1)

      ws.close()
      await waitForWsClose(ws)
      await waitFor(
        () =>
          server['mobileSocketWiring']?.channelCount === 0 &&
          server['mobileSocketWiring']?.connectionCount === 0
      )
    } finally {
      await server.stop()
    }
  })

  it('terminates active WebSockets for a revoked mobile device', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const disconnectSpy = vi.spyOn(runtime, 'onClientDisconnected')

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'mobile-test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const first = await authenticateMobileWs(offer.pairingUrl)
      const second = await authenticateMobileWs(offer.pairingUrl)

      await expect(server.revokeMobileDevice(offer.deviceId)).resolves.toBe(true)
      await Promise.all([waitForWsClose(first), waitForWsClose(second)])
      await waitFor(
        () =>
          server['mobileSocketWiring']?.channelCount === 0 &&
          server['mobileSocketWiring']?.connectionCount === 0
      )

      expect(disconnectSpy).toHaveBeenCalledTimes(1)
    } finally {
      disconnectSpy.mockRestore()
      await server.stop()
    }
  }, 15_000)

  it('does not revoke runtime-scoped devices through mobile revocation', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'runtime-test',
        scope: 'runtime'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }

      await expect(server.revokeMobileDevice(offer.deviceId)).resolves.toBe(false)
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('runtime')
    } finally {
      await server.stop()
    }
  })

  it('terminates active WebSockets for a revoked runtime access grant', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'runtime-test',
        scope: 'runtime'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const first = await authenticateMobileWs(offer.pairingUrl)
      const second = await authenticateMobileWs(offer.pairingUrl)

      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)
      await Promise.all([waitForWsClose(first), waitForWsClose(second)])
      await waitFor(
        () =>
          server['mobileSocketWiring']?.channelCount === 0 &&
          server['mobileSocketWiring']?.connectionCount === 0
      )

      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)).toBeNull()
    } finally {
      await server.stop()
    }
  }, 15_000)

  it.each([
    ['mobile', false],
    ['runtime', false],
    ['mobile', true]
  ] as const)(
    'revoking a %s bearer, removed on disk %s, removes descendants and closes their sockets',
    async (scope, removedOnDisk) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-fork-revoke-'))
      const server = new OrcaRuntimeRpcServer({
        runtime: new OrcaRuntimeService(),
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      await server.start()
      try {
        const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Parent', scope })
        if (!offer.available) {
          throw new Error('WebSocket pairing unavailable')
        }
        const parsed = parsePairingCode(offer.pairingUrl)!
        const parentSocket = await authenticateMobileWs(offer.pairingUrl)
        const registry = server.getDeviceRegistry()!
        const key = nacl.sign.keyPair()
        const fork = registry.forkDeviceKey(
          offer.deviceId,
          Buffer.from(key.publicKey).toString('base64'),
          'Fork'
        )
        const idleFork = registry.forkDeviceKey(
          offer.deviceId,
          Buffer.alloc(32, 9).toString('base64'),
          'Offline fork'
        )
        const { ws: forkSocket } = await authenticateKeyedWs(parsed, fork.deviceId, key)
        const children =
          scope === 'runtime'
            ? registry.upsertDelegatedMobileDevices(fork, [{ phoneKey: 'p', name: 'Pixel' }])
            : []
        const sockets = [parentSocket, forkSocket]
        for (const child of children) {
          sockets.push(
            await authenticateMobileWs(
              encodePairingOffer({
                ...parsed,
                deviceToken: child.token,
                pairedDeviceId: child.deviceId,
                scope: 'mobile'
              })
            )
          )
        }
        const unrelated = registry.addDevice('Unrelated', scope)
        const unrelatedSocket = await authenticateMobileWs(
          encodePairingOffer({
            ...parsed,
            deviceToken: unrelated.token,
            pairedDeviceId: unrelated.deviceId
          })
        )
        const closed = sockets.map(waitForWsClose)
        if (removedOnDisk) {
          const path = join(userDataPath, DEVICE_REGISTRY_FILENAME)
          const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
          writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== offer.deviceId)))
        }

        const revoked =
          scope === 'mobile'
            ? await server.revokeMobileDevice(offer.deviceId)
            : server.revokeRuntimeAccess(offer.deviceId)

        expect(revoked).toBe(true)
        for (const device of [fork, idleFork, ...children]) {
          expect(registry.getDevice(device.deviceId)).toBeNull()
          expect(new DeviceRegistry(userDataPath).getDevice(device.deviceId)).toBeNull()
        }
        await Promise.all(closed)
        expect(registry.validateToken(unrelated.token)?.deviceId).toBe(unrelated.deviceId)
        expect(unrelatedSocket.readyState).toBe(unrelatedSocket.OPEN)
        unrelatedSocket.close()
      } finally {
        await server.stop()
      }
    },
    15_000
  )

  it.each(['binary', 'text', 'sibling-cascade'] as const)(
    'retires an established keyed terminal subscription through %s revocation',
    async (kind) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-fork-stream-revoke-'))
      const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
      const write = vi.fn(() => true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'fork-stream-pty' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const cleanup = vi.spyOn(runtime, 'cleanupSubscriptionsForConnection')
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      await server.start()
      try {
        const terminal = await runtime.createTerminal('id:repo-1::/tmp/worktree-a')
        const offer = server.createPairingOffer({
          address: '127.0.0.1',
          name: 'Parent',
          scope: kind === 'sibling-cascade' ? 'mobile' : 'runtime'
        })
        if (!offer.available) {
          throw new Error('WebSocket pairing unavailable')
        }
        const registry = server.getDeviceRegistry()!
        const key = nacl.sign.keyPair()
        const earlier =
          kind === 'sibling-cascade'
            ? registry.forkDeviceKey(
                offer.deviceId,
                Buffer.alloc(32, 7).toString('base64'),
                'Earlier'
              )
            : null
        const fork = registry.forkDeviceKey(
          offer.deviceId,
          Buffer.from(key.publicKey).toString('base64'),
          'Fork'
        )
        const later =
          kind === 'sibling-cascade'
            ? registry.forkDeviceKey(
                offer.deviceId,
                Buffer.alloc(32, 8).toString('base64'),
                'Later'
              )
            : null
        if (kind === 'sibling-cascade') {
          server.setMobileRelayBinding(fork.deviceId, {
            relayHostId: 'host',
            relayDeviceId: fork.deviceId,
            ownerIdentityKey: 'owner'
          })
          registry.setPushRegistration(fork.deviceId, {
            registrationId: 'fork-push',
            filter: {},
            expiresAt: 4_000_000_000_000
          })
        }
        const { ws, peer } = await authenticateKeyedWs(
          parsePairingCode(offer.pairingUrl)!,
          fork.deviceId,
          key
        )
        const responses: { result?: { type?: string; streamId?: number } }[] = []
        ws.on('message', (data, isBinary) => {
          if (isBinary && Buffer.isBuffer(data)) {
            peer.openBinary(data)
          } else if (!isBinary) {
            responses.push(JSON.parse(peer.openText(data.toString())!))
          }
        })
        ws.send(
          peer.sealText(
            JSON.stringify({
              id: 'subscribe',
              method: 'terminal.subscribe',
              params: { terminal: terminal.handle, capabilities: { terminalBinaryStream: 1 } }
            })
          )
        )
        await waitFor(() => responses.some((response) => response.result?.type === 'subscribed'))
        const streamId = responses.find((response) => response.result?.type === 'subscribed')
          ?.result?.streamId
        if (streamId === undefined) {
          throw new Error('Expected binary terminal subscription')
        }
        const sendInput = (text: string) =>
          ws.send(
            peer.sealBinary(
              encodeTerminalStreamFrame({
                opcode: TerminalStreamOpcode.Input,
                streamId,
                seq: 1,
                payload: encodeTerminalStreamText(text)
              })
            )
          )
        sendInput('before')
        await waitFor(() => write.mock.calls.length === 1)
        const path = join(userDataPath, DEVICE_REGISTRY_FILENAME)
        const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
        writeFileSync(
          path,
          JSON.stringify(
            rows.filter(
              (row) =>
                row.deviceId !== (kind === 'sibling-cascade' ? fork.deviceId : offer.deviceId)
            )
          )
        )
        const closed = waitForWsClose(ws)

        if (kind === 'sibling-cascade') {
          expect(await server.revokeMobileDevice(offer.deviceId)).toBe(true)
          for (const device of [earlier, fork, later]) {
            if (device) {
              expect(registry.getDevice(device.deviceId)).toBeNull()
            }
          }
          expect(registry.getDevice(offer.deviceId)).toBeNull()
          expect(server.getRelayRevokeOutbox().pendingFor('owner', 'host')).toMatchObject([
            { relayDeviceId: fork.deviceId }
          ])
          expect(server.getPushUnregisterOutbox().pending()).toMatchObject([
            { deviceId: fork.deviceId, registrationId: 'fork-push' }
          ])
        } else if (kind === 'binary') {
          sendInput('after')
        } else {
          ws.send(peer.sealText(JSON.stringify({ id: 'denied', method: 'status.get' })))
        }

        await waitFor(
          () =>
            cleanup.mock.calls.length > 0 ||
            write.mock.calls.length > 1 ||
            responses.some((response) => 'error' in response)
        )
        expect(write).toHaveBeenCalledTimes(1)
        expect(cleanup).toHaveBeenCalledOnce()
        await closed
        expect(server['mobileSocketWiring']?.channelCount).toBe(0)
        expect(server['mobileSocketWiring']?.connectionCount).toBe(0)
      } finally {
        cleanup.mockRestore()
        await server.stop()
      }
    }
  )
})
