import {
  openSessionSearchHarness,
  addSyntheticSession
} from '../ai-vault-search/session-search-engine-test-fixture'
import { createSessionSearchService } from '../ai-vault-search/session-search-service'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from '../ai-vault-search/session-search-scope-catalog'
import { mkdtempSync, rmSync } from 'node:fs'
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
  return { server, registry, keyed, legacy, send, userDataPath }
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

it('carries canonical intent through the actual key-authenticated dispatch into native results', async () => {
  const { send, userDataPath, server } = keyedServer()
  const index = await openSessionSearchHarness('sta10541-key-native')
  try {
    addSyntheticSession(index.db, { id: 1, cwd: '/repo/app' })
    addSyntheticSession(index.db, { id: 2, cwd: '/other' })
    setSessionSearchService(
      createSessionSearchService({
        engine: index.engine,
        indexer: {
          status: () => {
            throw new Error('not called')
          },
          reconcile: async () => undefined
        }
      })
    )
    installSessionSearchScopeCatalogSource(() => ({
      repos: [{ id: 'app', path: '/repo/app', displayName: 'app', badgeColor: '', addedAt: 1 }],
      projects: [],
      projectHostSetups: [],
      worktreeMeta: {},
      settings: { workspaceDir: '', nestWorkspaces: false }
    }))
    expect(
      await send({
        id: 'key-search',
        method: 'aiVault.searchSessions',
        params: {
          query: 'needle',
          within: { kind: 'project', projectKey: 'repo:app', canonicalProjectKey: 'repo:app' }
        }
      })
    ).toMatchObject({ ok: true, result: { kind: 'results', hits: [{ sessionId: '1' }] } })
  } finally {
    setSessionSearchService(null)
    resetSessionSearchScopeCatalogForTests()
    await index.close()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
