import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage } from '../../shared/device-key-proof'
import { devicePrincipalOf } from './device-principal'
import { DeviceRegistry } from './device-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'
import { visibleSnapshot } from './rpc/methods/session-tabs-snapshot.test-fixture'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

function keyedServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-dispatch-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get only reads these three members.
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'test-runtime',
    getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
  } as unknown as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  const registry = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = registry
  const legacy = registry.addDevice('Laptop', 'runtime')
  const keyed = registry.forkDeviceKey(
    legacy.deviceId,
    Buffer.alloc(32, 5).toString('base64'),
    'Mac'
  )
  const socket: AuthenticatedMobileSocket = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
    ws: {} as AuthenticatedMobileSocket['ws'],
    connectionId: 'connection-1',
    transcriptHashB64: Buffer.alloc(32).toString('base64'),
    device: devicePrincipalOf(keyed),
    clientCapabilities: [],
    transport: { transport: 'direct' }
  }
  const send = async (request: Record<string, unknown>) => {
    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify(request),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      null,
      socket
    )
    const reply: unknown = JSON.parse(replies.at(-1)!)
    return reply
  }
  return { server, registry, keyed, legacy, send }
}

describe('requests on a key-authenticated socket', () => {
  it('dispatch with the device id as client id and no token', async () => {
    const { server, keyed, send } = keyedServer()
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')
    const reply = await send({ id: 'r1', method: 'status.get' })
    expect(reply).not.toMatchObject({ error: { code: 'unauthorized' } })
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      clientId: keyed.deviceId,
      pairedDeviceId: keyed.deviceId
    })
  })

  it('refuses a request that carries any token, and every request once the row is revoked', async () => {
    const { registry, keyed, legacy, send } = keyedServer()
    expect(await send({ id: 'r1', method: 'status.get', deviceToken: legacy.token })).toMatchObject(
      {
        ok: false,
        error: { code: 'unauthorized' }
      }
    )
    registry.removeDevice(keyed.deviceId)
    expect(await send({ id: 'r2', method: 'status.get' })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})

describe('pairing.registerDeviceKey over the dispatcher', () => {
  it.each(['runtime', 'mobile'] as const)(
    'forks a %s token row bound to the calling socket',
    async (scope) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-register-'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration never touches the runtime service.
      const runtime = {
        configureNotificationDismissalStore: () => {},
        getRuntimeId: () => 'test-runtime'
      } as unknown as OrcaRuntimeService
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
      const registry = new DeviceRegistry(userDataPath)
      server['deviceRegistry'] = registry
      const legacy = registry.addDevice('Device', scope)
      const transcriptHashB64 = Buffer.alloc(32, 9).toString('base64')
      const key = nacl.sign.keyPair()
      const proof = nacl.sign.detached(
        encodeDeviceProofMessage('register', Buffer.from(transcriptHashB64, 'base64')),
        key.secretKey
      )
      const replies: string[] = []
      await server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'register',
          method: 'pairing.registerDeviceKey',
          params: {
            devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
            deviceProofB64: Buffer.from(proof).toString('base64'),
            deviceLabel: 'Laptop'
          }
        }),
        (response) => replies.push(response),
        () => {},
        undefined,
        undefined,
        legacy.token,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
          ws: {} as AuthenticatedMobileSocket['ws'],
          connectionId: 'connection-1',
          transcriptHashB64,
          device: { ...devicePrincipalOf(legacy), deviceToken: legacy.token },
          clientCapabilities: [],
          transport: { transport: 'direct' }
        }
      )
      const reply: unknown = JSON.parse(replies.at(-1)!)
      expect(reply).toMatchObject({ id: 'register', ok: true, result: { credentialRevision: 0 } })
      expect(
        registry.listDevices().filter((row) => row.forkedFrom === legacy.deviceId)
      ).toHaveLength(1)
    }
  )
})

describe('streams on an authenticated phone socket', () => {
  it('re-project when the phone later updates its capabilities on that socket', async () => {
    const snapshot = {
      ...visibleSnapshot(),
      tabs: [
        {
          type: 'agent-session' as const,
          id: 'claude',
          sessionId: 'claude-session',
          agent: 'claude',
          title: 'Claude chat',
          isActive: true
        }
      ]
    }
    const cleanups = new Map<string, () => void>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: phone auth and session.tabs.subscribe read only these members.
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      getStartedAt: () => 1,
      machineNameReady: async () => undefined,
      getStatus: () => ({ graphStatus: 'unavailable' }),
      onClientDisconnected: () => {},
      cleanupSubscriptionsForConnection: () => {},
      listMobileSessionTabs: async () => snapshot,
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
      cleanupSubscription: (id: string) => cleanups.get(id)?.(),
      onMobileSessionTabsChanged: () => () => {}
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-phone-capability-dispatch-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'p', scope: 'mobile' })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    // Token auth carries no capabilities, as a phone's does before its advisory update.
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const reader = createEncryptedWsResponseReader(session)
    try {
      sendEncryptedWsRequest(session, {
        id: 'tabs',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:wt-1' }
      })
      expect(JSON.stringify(await reader.next('tabs'))).toContain('Open on desktop')
      sendEncryptedWsRequest(session, {
        id: 'caps',
        method: 'runtime.clientCapabilities.update',
        params: {
          clientCapabilities: ['agent-session.structured.v1', 'agent-session.structured.claude.v1']
        }
      })
      const recovered = await reader.next('tabs')
      expect(recovered).toMatchObject({ result: { type: 'updated' } })
      expect(JSON.stringify(recovered)).toContain('Claude chat')
    } finally {
      reader.dispose()
      session.ws.close()
      await server.stop()
    }
  })
})
