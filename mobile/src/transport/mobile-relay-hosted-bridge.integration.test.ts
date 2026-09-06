import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileWebCapabilityBroker } from '../mobile-web/mobile-web-capability-broker'
import { MOBILE_WEB_PRODUCTION_GRANTS } from '../mobile-web/mobile-web-production-grants'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeMessageContext
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { DeviceRegistry } from '../../../src/main/runtime/device-registry'
import { MobileSocketWiring } from '../../../src/main/runtime/rpc/mobile-socket-wiring'
import { CloudRelayTransport } from '../../../src/main/runtime/rpc/relay-transport'
import { deriveRelayHostId } from '../../../src/main/runtime/relay/relay-http-client'
import { MobileWebPackageAssets } from '../../../src/main/runtime/rpc/mobile-web-package-assets'
import {
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  type MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import type { MobileWebPackageAssetParams } from '../../../src/shared/mobile-web/package-rpc-contract'
import { downloadMobileWebPackage } from '../mobile-web/mobile-web-package-downloader'
import {
  createRecordingRelayPackageStager,
  createRelayMobileWebPackageFixture
} from './mobile-relay-package-download-test-fixture'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))

type RelayRpcRequest = {
  id: string
  method: string
  params?: Record<string, unknown>
}

function forward(socket: WebSocket, raw: RawData, isBinary: boolean): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(raw, { binary: isBinary })
  }
}

describe('hosted mobile bridge over cloud Relay transport', () => {
  const servers: WebSocketServer[] = []
  const transports: CloudRelayTransport[] = []
  const userDataPaths: string[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop()))
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
    for (const path of userDataPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('carries hosted authority and package delivery through the real mobile Relay client', async () => {
    const relayServer = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: false
    })
    servers.push(relayServer)
    await new Promise<void>((resolve) => relayServer.once('listening', resolve))
    const address = relayServer.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected local relay TCP address')
    }

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hosted-relay-'))
    userDataPaths.push(userDataPath)
    const packageFixture = createRelayMobileWebPackageFixture()
    userDataPaths.push(packageFixture.root)
    const packageAssets = new MobileWebPackageAssets({
      resolveRoot: () => packageFixture.root
    })
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Relay phone', 'mobile')
    const desktopKeys = nacl.box.keyPair()
    const relayHostId = deriveRelayHostId(desktopKeys.publicKey)
    const relayEndpoint = {
      v: 1 as const,
      directorUrl: 'https://relay.example.test',
      cellUrl: 'https://relay-c1.example.test',
      assignmentEpoch: 1,
      relayHostId,
      e2eeFraming: 2 as const
    }
    const observedMethods: string[] = []
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktopKeys.publicKey,
        secretKey: desktopKeys.secretKey,
        publicKeyB64: Buffer.from(desktopKeys.publicKey).toString('base64')
      },
      onText: (socket, plaintext, reply) => {
        const request = JSON.parse(plaintext) as RelayRpcRequest
        observedMethods.push(request.method)
        if (request.method === 'pairing.getEndpoints') {
          reply(
            rpcSuccess(request.id, {
              v: 1,
              relay: relayEndpoint,
              resumeConfirmation: {
                v: 1,
                reqId: request.params?.resumeConfirmReqId,
                currentVersion: 3,
                acceptedAs: 'current',
                renewed: true,
                resumeExpiresAt: Date.now() + 300_000
              }
            })
          )
          return
        }
        if (request.method === 'worktree.ps') {
          reply(
            rpcSuccess(request.id, {
              worktrees: [
                {
                  worktreeId: 'host-relay-workspace',
                  repoId: 'host-relay-repo',
                  displayName: 'Relay workspace',
                  repo: 'Orca',
                  branch: 'relay'
                }
              ]
            })
          )
          return
        }
        if (request.method === 'session.tabs.list') {
          reply(rpcSuccess(request.id, relaySessionSnapshot()))
          return
        }
        if (request.method === 'nativeChat.readSession') {
          expect(request.params).toEqual({
            agent: 'codex',
            sessionId: 'relay-provider-session',
            limit: 40,
            transcriptPath: '/private/relay-transcript.jsonl',
            worktreeId: 'host-relay-workspace',
            terminal: 'host-relay-terminal'
          })
          reply(
            rpcSuccess(request.id, {
              messages: [
                {
                  id: 'relay-message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Relay native chat' }],
                  timestamp: 1,
                  source: 'transcript'
                }
              ],
              hasMore: false
            })
          )
          return
        }
        if (request.method === 'mobileWeb.package.manifest') {
          replyPackageOperation(request.id, packageAssets.getManifest(), reply)
          return
        }
        if (request.method === 'mobileWeb.package.asset') {
          replyPackageOperation(
            request.id,
            packageAssets.getAssetChunk(request.params as MobileWebPackageAssetParams, {
              connectionId: socket.connectionId
            }),
            reply
          )
          return
        }
        if (request.method === 'mobileWeb.package.asset.gzip') {
          replyPackageOperation(
            request.id,
            packageAssets.getAssetGzipChunk(request.params as MobileWebPackageAssetParams, {
              connectionId: socket.connectionId
            }),
            reply
          )
          return
        }
        reply(rpcSuccess(request.id, {}))
      },
      onBinary: vi.fn(),
      onClose: vi.fn()
    })

    let hostSocket: WebSocket | null = null
    let phoneSocket: WebSocket | null = null
    const splice = (): void => {
      if (!hostSocket || !phoneSocket) {
        return
      }
      const host = hostSocket
      const phone = phoneSocket
      host.on('message', (raw, isBinary) => forward(phone, raw, isBinary))
      phone.on('message', (raw, isBinary) => forward(host, raw, isBinary))
      phone.send(
        JSON.stringify({
          type: 'relay-hello',
          ok: true,
          credentialKind: 'resume',
          leaseExpiresAt: Date.now() + 60_000,
          acceptedCredentialVersion: 3,
          acceptedAs: 'current',
          resumeExpiresAt: Date.now() + 300_000
        })
      )
    }
    relayServer.on('connection', (socket, request) => {
      if (request.url === '/v1/host/data/connection-1') {
        socket.once('message', (raw) => {
          expect(JSON.parse(raw.toString())).toEqual({
            type: 'host-data-auth',
            v: 1,
            connTicket: 'A'.repeat(43),
            generation: 1
          })
          hostSocket = socket
          splice()
        })
        return
      }
      expect(request.url).toBe(`/v1/connect/${relayHostId}`)
      socket.once('message', (raw) => {
        expect(JSON.parse(raw.toString())).toEqual({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: 'B'.repeat(43)
        })
        phoneSocket = socket
        splice()
      })
    })

    const transport = new CloudRelayTransport({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayHostId,
      generation: 1
    })
    transports.push(transport)
    wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
    await transport.start()
    await transport.openConnection({
      connId: 'connection-1',
      connTicket: 'A'.repeat(43),
      kind: 'resume',
      relayDeviceId: device.deviceId,
      attachDeadlineMs: 5_000
    })

    const relaySocketUrl = `ws://127.0.0.1:${address.port}/v1/connect/${relayHostId}`
    const session = connectMobileRelayRpcSession({
      relay: relayEndpoint,
      resumeToken: 'B'.repeat(43),
      resumeCredentialVersion: 3,
      resumeConfirmReqId: 'confirm-1',
      deviceToken: device.token,
      desktopPublicKeyB64: Buffer.from(desktopKeys.publicKey).toString('base64'),
      requestTimeoutMs: 5_000,
      createSocket: (url) => {
        expect(url).toBe(`wss://relay-c1.example.test/v1/connect/${relayHostId}`)
        return new WebSocketClient(relaySocketUrl, {
          perMessageDeflate: false
        }) as unknown as globalThis.WebSocket
      }
    })
    await vi.waitFor(() => expect(session.getState()).toBe('connected'), { timeout: 5_000 })

    const context: MobileWebBridgeMessageContext = {
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64)
    }
    let broker: MobileWebCapabilityBroker
    let requestIndex = 0
    const pageClient = new MobileWebBridgeClient({
      context,
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
      postMessage(message) {
        const parsed = parseMobileWebBridgePageMessage(JSON.stringify(message), context)
        if (!parsed.ok) {
          return false
        }
        void broker.handle(parsed.value)
        return true
      }
    })
    broker = new MobileWebCapabilityBroker({
      context,
      getClient: () => session,
      isConnected: () => session.getState() === 'connected',
      isActive: () => true,
      postMessage(message) {
        const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), context)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        pageClient.receive(parsed.value)
      },
      nativeAuthority: {
        hapticFeedback() {},
        async clipboardWrite() {
          return { confirmation: 'in-app' }
        },
        async openExternal() {},
        async terminalPreferences() {
          return { textScale: 1, autocompleteEnabled: true, linkOpenMode: 'orca-browser' }
        },
        async terminalTextScaleUpdate() {}
      },
      terminalClientId: device.token,
      randomBytes: (length) => new Uint8Array(length).fill(1)
    })

    const snapshot = await pageClient.workspaceSnapshot({ limit: 10 })
    expect(snapshot).toMatchObject({
      workspaces: [
        {
          name: 'Relay workspace',
          repo: 'Orca',
          branch: 'relay',
          workspaceKind: 'git'
        }
      ],
      truncated: false
    })
    expect(observedMethods).toEqual([
      'pairing.getEndpoints',
      'runtime.clientCapabilities.update',
      'worktree.ps'
    ])
    expect(JSON.stringify(snapshot)).not.toContain('host-relay-workspace')

    const workspace = snapshot.workspaces[0]!
    const sessionSnapshot = await pageClient.sessionSnapshot({ workspaceId: workspace.id })
    const terminal = sessionSnapshot.tabs[0]
    if (terminal?.type !== 'terminal' || !terminal.nativeChatSessionId) {
      throw new Error('expected opaque Relay native-chat authority')
    }
    const transcript = await pageClient.nativeChat.read({
      workspaceId: workspace.id,
      sessionId: terminal.nativeChatSessionId,
      limit: 40
    })
    expect(transcript.messages).toEqual([
      {
        id: 'relay-message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Relay native chat' }],
        timestamp: 1,
        source: 'transcript'
      }
    ])
    expect(observedMethods).toEqual([
      'pairing.getEndpoints',
      'runtime.clientCapabilities.update',
      'worktree.ps',
      'session.tabs.list',
      'session.tabs.list',
      'nativeChat.readSession'
    ])
    expect(JSON.stringify({ sessionSnapshot, transcript })).not.toContain('relay-provider-session')
    expect(JSON.stringify({ sessionSnapshot, transcript })).not.toContain(
      '/private/relay-transcript.jsonl'
    )

    const stager = createRecordingRelayPackageStager()
    const downloaded = await downloadMobileWebPackage(
      (method, params) => session.sendRequest(method, params),
      stager,
      { shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION, useGzip: true }
    )
    expect(downloaded.manifest).toEqual(packageFixture.manifest)
    expect(downloaded.commit).toEqual({ buildId: packageFixture.manifest.buildId })
    expect(observedMethods.slice(-4)).toEqual([
      'mobileWeb.package.manifest',
      'mobileWeb.package.asset.gzip',
      'mobileWeb.package.asset.gzip',
      'mobileWeb.package.asset.gzip'
    ])
    expectPackageStaging(packageFixture.manifest, packageFixture.bytesByPath, stager)

    pageClient.dispose()
    broker.dispose()
    session.close()
  }, 15_000)
})

function rpcSuccess(id: string, result: unknown): string {
  return JSON.stringify({
    id,
    ok: true,
    result,
    _meta: { runtimeId: 'relay-runtime' }
  })
}

function replyPackageOperation(
  id: string,
  operation: Promise<unknown>,
  reply: (response: string) => void
): void {
  void operation.then((result) => reply(rpcSuccess(id, result)))
}

function expectPackageStaging(
  manifest: MobileWebManifest,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
  stager: ReturnType<typeof createRecordingRelayPackageStager>
): void {
  const expectedEvents = ['begin']
  for (const asset of manifest.assets) {
    const writes = stager.writes.filter((write) => write.path === asset.path)
    const expectedOffsets: number[] = []
    for (let offset = 0; offset < asset.byteLength; offset += MOBILE_WEB_PACKAGE_CHUNK_BYTES) {
      expectedOffsets.push(offset)
      expectedEvents.push(`write:${asset.path}:${offset}`)
    }
    expectedEvents.push(`finish:${asset.path}`)
    expect(writes.map((write) => write.offset)).toEqual(expectedOffsets)
    expect(Buffer.concat(writes.map((write) => Buffer.from(write.bytes)))).toEqual(
      Buffer.from(bytesByPath.get(asset.path)!)
    )
  }
  expectedEvents.push('commit')
  expect(stager.events).toEqual(expectedEvents)
}

function relaySessionSnapshot() {
  return {
    worktree: 'host-relay-workspace',
    publicationEpoch: 'relay-epoch',
    snapshotVersion: 1,
    workspaceTransportState: 'available',
    activeTabId: 'host-relay-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-relay-tab',
        title: 'Codex',
        status: 'ready',
        terminal: 'host-relay-terminal',
        launchAgent: 'codex',
        isActive: true,
        agentStatus: {
          state: 'done',
          agentType: 'codex',
          providerSession: {
            id: 'relay-provider-session',
            transcriptPath: '/private/relay-transcript.jsonl'
          }
        }
      }
    ]
  }
}
