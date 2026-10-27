import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { defineMethod } from './rpc/core'
import { OBSERVER_METHODS } from './rpc/methods/observer'
import { MobileSocketWiring } from './rpc/mobile-socket-wiring'
import { WebSocketTransport } from './rpc/ws-transport'
import type { DeviceRegistry } from './device-registry'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair
} from '../../shared/e2ee-crypto'

function fixture() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-observer-rpc-'))
  const mutate = vi.fn(() => ({ changed: true }))
  const observeIdentity = vi.fn((_params: void, context: { caller?: unknown }) => context.caller)
  const sourceRows = [
    {
      paneKey: 'pane-b',
      worktreeId: 'worktree-in-scope',
      connectionId: null,
      receivedAt: 20,
      stateStartedAt: 10,
      providerSession: { id: 'opaque-and-never-returned' }
    },
    {
      paneKey: 'pane-outside',
      worktreeId: 'another-worktree',
      connectionId: null,
      receivedAt: 30,
      stateStartedAt: 10
    }
  ]
  const boundedSnapshot = vi.fn((worktreeId: string, _scanLimit: number, rowLimit: number) => {
    const matches = sourceRows.filter((row) => row.worktreeId === worktreeId)
    return {
      rows: matches.slice(0, rowLimit),
      truncated: matches.length > rowLimit
    }
  })
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'runtime-fictional',
    getStatus: () => ({
      runtimeId: 'runtime-fictional',
      runtimeProtocolVersion: 31,
      minCompatibleRuntimeClientVersion: 30,
      graphStatus: 'ready',
      hostPlatform: 'linux'
    }),
    showManagedWorktree: async (selector: string) => ({
      id: selector,
      instanceId: 'instance-in-scope'
    }),
    getAgentProviderSessionRows: () => {
      throw new Error('unbounded_snapshot_must_not_be_used_by_observer')
    },
    getBoundedAgentProviderSessionRows: boundedSnapshot
  } as unknown as OrcaRuntimeService
  const methods = [
    ...OBSERVER_METHODS,
    defineMethod({
      name: 'fictional.observeIdentity',
      permission: 'observer-read',
      params: null,
      handler: observeIdentity
    }),
    defineMethod({
      name: 'fictional.mutate',
      permission: 'workspace',
      params: null,
      handler: mutate
    })
  ]
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, methods })
  const credential = server['observerCredentialStore'].issue(
    'worktree-in-scope',
    'instance-in-scope'
  )
  return {
    server,
    credential,
    mutate,
    observeIdentity,
    boundedSnapshot,
    runtime
  }
}

function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()))
    socket.once('error', reject)
  })
}

describe('observer RPC authorization (#31308)', () => {
  it('denies a Unix mutation before its handler and emits an effect:false receipt', async () => {
    const { server, credential, mutate } = fixture()
    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'deny-unix',
        authToken: credential.token,
        method: 'fictional.mutate'
      })
    )
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        data: {
          receipt: {
            requestId: 'deny-unix',
            credentialId: credential.id,
            method: 'fictional.mutate',
            effect: false
          }
        }
      }
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('stamps a first-class observer caller identity and never falls back to local-cli', async () => {
    const { server, credential, observeIdentity } = fixture()
    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'identity',
        authToken: credential.token,
        method: 'fictional.observeIdentity'
      })
    )
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'observer', credentialId: credential.id }
    })
    expect(observeIdentity).toHaveBeenCalledOnce()
  })

  it('uses the real direct E2EE WebSocket handshake, denies mutation, and rechecks revocation', async () => {
    const { server, credential, mutate } = fixture()
    const desktop = generateKeyPair()
    const client = generateKeyPair()
    const onReady = vi.fn()
    const onBinary = vi.fn()
    const onUnpairedDeviceAuthFailure = vi.fn()
    const registry = {
      validateToken: () => null,
      pruneIdleEphemeralDevices: () => [],
      updateLastSeenDeferred: vi.fn()
    } as unknown as DeviceRegistry
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      resolveObserverCredential: (token) => server['observerCredentialStore'].authenticate(token),
      onText: (socket, plaintext, reply, sendBinary) => {
        void server['handleWebSocketMessage'](
          plaintext,
          reply,
          sendBinary,
          undefined,
          socket.ws,
          socket.device.deviceToken ?? null,
          socket
        )
      },
      onBinary,
      onClose: vi.fn(),
      onReady,
      onUnpairedDeviceAuthFailure
    })
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    wiring.attachTransport(transport)
    await transport.start()
    const socket = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
      const ready = nextText(socket)
      socket.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(client.publicKey).toString('base64')
        })
      )
      expect(JSON.parse(await ready)).toMatchObject({ type: 'e2ee_ready' })
      const sharedKey = deriveSharedKey(client.secretKey, desktop.publicKey)

      const authenticated = nextText(socket)
      socket.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: credential.token }), sharedKey)
      )
      expect(JSON.parse(decrypt(await authenticated, sharedKey)!)).toMatchObject({
        type: 'e2ee_authenticated'
      })
      expect(onReady).not.toHaveBeenCalled()
      expect(onUnpairedDeviceAuthFailure).not.toHaveBeenCalled()

      // Binary frames on an observer principal are consumed at E2EE but never reach runtime routing.
      socket.send(encryptBytes(new Uint8Array([1, 2, 3]), sharedKey))
      const denied = nextText(socket)
      socket.send(encrypt(JSON.stringify({ id: 'deny-ws', method: 'fictional.mutate' }), sharedKey))
      expect(JSON.parse(decrypt(await denied, sharedKey)!)).toMatchObject({
        ok: false,
        error: {
          code: 'forbidden',
          data: {
            receipt: {
              requestId: 'deny-ws',
              credentialId: credential.id,
              effect: false
            }
          }
        }
      })
      expect(mutate).not.toHaveBeenCalled()
      expect(onBinary).not.toHaveBeenCalled()
      expect(onUnpairedDeviceAuthFailure).not.toHaveBeenCalled()

      expect(server['observerCredentialStore'].revoke(credential.id)).toBe(true)
      const revoked = nextText(socket)
      socket.send(
        encrypt(
          JSON.stringify({
            id: 'revoked-ws',
            method: 'observer.sessions.list'
          }),
          sharedKey
        )
      )
      expect(JSON.parse(decrypt(await revoked, sharedKey)!)).toMatchObject({
        ok: false,
        error: { code: 'unauthorized' }
      })
    } finally {
      socket.close()
      wiring.dispose()
      await transport.stop()
    }
  })

  it('returns only current-instance scoped observations without paths or provider credentials', async () => {
    const { server, credential } = fixture()
    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'sessions',
        authToken: credential.token,
        method: 'observer.sessions.list'
      })
    )
    expect(response).toMatchObject({
      ok: true,
      result: {
        scope: { worktreeInstanceId: 'instance-in-scope' },
        sessions: [
          {
            sessionRef: expect.stringMatching(/^[a-f0-9]{32}$/),
            providerSessionPresent: true
          }
        ]
      }
    })
    expect(JSON.stringify(response)).not.toContain('pane-b')
    expect(JSON.stringify(response)).not.toContain('opaque-and-never-returned')
    expect(JSON.stringify(response)).not.toContain('another-worktree')
    expect(JSON.stringify(response)).not.toContain('worktree-in-scope')
  })

  it('fails closed when the current catalog instance no longer matches the credential', async () => {
    const { server, credential, runtime } = fixture()
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'worktree-in-scope',
      instanceId: 'replacement-instance'
    } as never)
    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'stale-instance',
        authToken: credential.token,
        method: 'observer.sessions.list'
      })
    )
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'observer_scope_stale' }
    })
  })

  it('denies unknown method names with the same no-effect receipt', async () => {
    const { server, credential } = fixture()
    const response = await server['handleMessage'](
      JSON.stringify({
        id: 'unknown',
        authToken: credential.token,
        method: 'future.unregistered'
      })
    )
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        data: { receipt: { method: 'future.unregistered', effect: false } }
      }
    })
  })
})
