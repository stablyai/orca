import { SKILL_INSTALL_RESULT_V2_CAPABILITY } from '../../shared/skill-install-capability'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from '../../shared/e2ee-crypto'
import { sendWebSocketRequestWithStatusPreflight } from './websocket-transport'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../../shared/remote-runtime/requests/remote-runtime-prepared-request-admission'
import { RuntimeClient } from './client'
import { requestWorktreeRemoval } from '../handlers/worktree-removal-request'
import { launchOrcaApp } from './launch'
import { addEnvironmentFromPairingCode } from './environments'
import { RuntimeClientError } from './types'
import {
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
} from '../../shared/terminal-quick-command-capabilities'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../shared/agent-session-background-task-child-views-capability'

vi.mock('./launch', () => ({
  launchOrcaApp: vi.fn()
}))

type TestRuntime = {
  endpoint: string
  publicKeyB64: string
  deviceToken: string
  authFrames: Record<string, unknown>[]
  requestMethods: string[]
  requestParams: unknown[]
  connectionCount: () => number
  close: () => Promise<void>
}

describe('CLI remote WebSocket transport', () => {
  const servers: TestRuntime[] = []

  afterEach(async () => {
    vi.mocked(launchOrcaApp).mockClear()
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it('calls a remote runtime through a mobile pairing offer', async () => {
    const runtime = await startTestRuntime('runtime-ws-1')
    servers.push(runtime)

    const pairingUrl = encodePairingOffer({
      v: 2,
      endpoint: runtime.endpoint,
      deviceToken: runtime.deviceToken,
      publicKeyB64: runtime.publicKeyB64
    })
    const client = new RuntimeClient('/tmp/unused', 5_000, pairingUrl)
    const response = await client.call<{ runtimeId: string }>('status.get')
    expect(await client.getOfflineRuntimeAdmission()).toEqual({
      reachable: true,
      legacyPidRunning: false,
      pid: null
    })

    expect(response.ok).toBe(true)
    expect(response.result.runtimeId).toBe('runtime-ws-1')
    expect(runtime.authFrames).toContainEqual(
      expect.objectContaining({
        clientCapabilities: [
          AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
          AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
          AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
          AGENT_SESSION_TURN_ITEM_CAPABILITY,
          SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
          SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
          AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
          SKILL_INSTALL_RESULT_V2_CAPABILITY,
          WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
          WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
          WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
          AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
          REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
          TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY,
          TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
          AGENT_LAUNCH_RUNTIME_CAPABILITY
        ]
      })
    )
  })

  it('rejects malformed remote pairing codes before local runtime lookup', () => {
    expect(() => new RuntimeClient('/tmp/unused', 5_000, 'not-a-pairing-code')).toThrow(
      RuntimeClientError
    )
  })

  it('accepts a bare pairing payload as well as the orca URL wrapper', async () => {
    const runtime = await startTestRuntime('runtime-ws-2', {
      appVersion: '1.5.0',
      remoteUpdateSupport: {
        installMode: 'unsupported-headless-serve',
        automatic: false,
        reason: 'manual-service-update-required'
      },
      capabilities: ['updater.remote-control.v1'],
      degradations: [
        {
          code: 'browser_unavailable',
          capability: 'browser.headless.v1',
          message: 'Browser automation is unavailable.'
        }
      ]
    })
    servers.push(runtime)
    const offer: PairingOffer = {
      v: 2,
      endpoint: runtime.endpoint,
      deviceToken: runtime.deviceToken,
      publicKeyB64: runtime.publicKeyB64
    }
    const pairingUrl = encodePairingOffer(offer)
    const barePayload = new URLSearchParams(pairingUrl.slice(pairingUrl.indexOf('?') + 1)).get(
      'code'
    )!

    const client = new RuntimeClient('/tmp/unused', 5_000, barePayload)
    const status = await client.getCliStatus()

    expect(status.result.app).toEqual({ running: false, pid: null })
    expect(status.result.runtime.reachable).toBe(true)
    expect(status.result.runtime.runtimeId).toBe('runtime-ws-2')
    expect(status.result.runtime).toMatchObject({
      appVersion: '1.5.0',
      remoteUpdateSupport: { automatic: false, reason: 'manual-service-update-required' },
      capabilities: ['updater.remote-control.v1'],
      degradations: [expect.objectContaining({ code: 'browser_unavailable' })]
    })
  })

  it('does not launch a local desktop app for remote-paired open', async () => {
    const runtime = await startTestRuntime('runtime-remote-headless', {
      desktopWindowStatus: 'initializing'
    })
    servers.push(runtime)
    const client = new RuntimeClient(
      '/tmp/unused',
      5_000,
      encodePairingOffer({
        v: 2,
        endpoint: runtime.endpoint,
        deviceToken: runtime.deviceToken,
        publicKeyB64: runtime.publicKeyB64
      })
    )

    const status = await client.openOrca()

    expect(status.result.app.desktopWindowStatus).toBe('initializing')
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })

  it('connects through a saved environment selector', async () => {
    const runtime = await startTestRuntime('runtime-env-1')
    servers.push(runtime)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-env-'))
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'remote-dev',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: runtime.endpoint,
        deviceToken: runtime.deviceToken,
        publicKeyB64: runtime.publicKeyB64
      })
    })

    const client = new RuntimeClient(userDataPath, 5_000, null, 'remote-dev')
    const status = await client.getCliStatus()

    expect(status.result.app).toEqual({ running: false, pid: null })
    expect(status.result.runtime.reachable).toBe(true)
    expect(status.result.runtime.runtimeId).toBe('runtime-env-1')
  })

  it('blocks remote RPCs when the server protocol is too old', async () => {
    const runtime = await startTestRuntime('runtime-old', { runtimeProtocolVersion: 1 })
    servers.push(runtime)

    const client = new RuntimeClient(
      '/tmp/unused',
      5_000,
      encodePairingOffer({
        v: 2,
        endpoint: runtime.endpoint,
        deviceToken: runtime.deviceToken,
        publicKeyB64: runtime.publicKeyB64
      })
    )

    await expect(client.call('repo.list')).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('server is too old')
    })
    expect(runtime.connectionCount()).toBe(1)
    expect(runtime.authFrames).toHaveLength(1)
    expect(runtime.requestMethods).toEqual(['status.get'])
  })

  it('preflights and dispatches through one authenticated connection', async () => {
    const runtime = await startTestRuntime('runtime-single-auth')
    servers.push(runtime)
    const client = new RuntimeClient(
      '/tmp/unused',
      5_000,
      encodePairingOffer({
        v: 2,
        endpoint: runtime.endpoint,
        deviceToken: runtime.deviceToken,
        publicKeyB64: runtime.publicKeyB64
      })
    )

    await expect(client.call('repo.list')).rejects.toMatchObject({ code: 'method_not_found' })

    expect(runtime.connectionCount()).toBe(1)
    expect(runtime.authFrames).toHaveLength(1)
    expect(runtime.requestMethods).toEqual(['status.get', 'repo.list'])
  })

  it('blocks orchestration mutations when a remote runtime lacks the contract capability', async () => {
    const runtime = await startTestRuntime('runtime-old-orchestration', { capabilities: [] })
    servers.push(runtime)
    const client = new RuntimeClient(
      '/tmp/unused',
      5_000,
      encodePairingOffer({
        v: 2,
        endpoint: runtime.endpoint,
        deviceToken: runtime.deviceToken,
        publicKeyB64: runtime.publicKeyB64
      })
    )

    await expect(client.call('orchestration.send', { subject: 'hello' })).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: {
        reason: 'runtime_capability_missing',
        effectsApplied: false
      }
    })
  })

  it.each(['status', 'capable-mutation', 'legacy-mutation'] as const)(
    'reports paired timeout at %s without replay',
    async (phase) => {
      const received = Promise.withResolvers<void>()
      const status: Parameters<typeof startTestRuntime>[1] = {
        capabilities: ['worktree.remove-branch-policy.v1']
      }
      const runtime = await startTestRuntime('timeout', status)
      servers.push(runtime)
      const client = new RuntimeClient(
        '/tmp/unused',
        5000,
        encodePairingOffer({
          v: 2,
          endpoint: runtime.endpoint,
          deviceToken: runtime.deviceToken,
          publicKeyB64: runtime.publicKeyB64
        })
      )
      await client.getCliStatus()
      status.hold = phase === 'status' ? 'status.get' : 'worktree.rm'
      if (phase === 'legacy-mutation') {
        status.capabilities = undefined
      }
      status.onRequest = (method) => {
        if (method === status.hold) {
          received.resolve()
        }
      }
      const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const response = requestWorktreeRemoval(client, {
          worktree: 'id:task',
          hostId: 'local',
          force: false,
          deleteBranch: false,
          runHooks: false,
          allowFailedArchiveHook: false
        }).catch((error: unknown) => error)
        await received.promise
        await vi.runAllTimersAsync()
        expect(await response).toMatchObject({
          code: phase === 'status' ? 'runtime_timeout' : 'worktree_removal_in_progress'
        })
        expect(runtime.requestMethods).toEqual(
          phase === 'status'
            ? ['status.get', 'status.get']
            : ['status.get', 'status.get', 'worktree.rm']
        )
        expect(warning.mock.calls).toHaveLength(phase === 'legacy-mutation' ? 1 : 0)
        expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
          pendingRequestCount: 0,
          retainedBytes: 0
        })
      } finally {
        vi.useRealTimers()
        warning.mockRestore()
      }
    }
  )

  it('selects paired params before serialization and releases failed preparation without dispatch', async () => {
    const runtime = await startTestRuntime('prepare')
    servers.push(runtime)
    const dispatched = vi.fn()
    await expect(
      sendWebSocketRequestWithStatusPreflight(
        {
          endpoint: runtime.endpoint,
          hostPublicKeyB64: runtime.publicKeyB64,
          credential: { kind: 'token', deviceToken: runtime.deviceToken }
        },
        'worktree.rm',
        {},
        5000,
        () => {},
        undefined,
        { paramsForStatus: () => ({ value: 1n }), onDispatch: dispatched }
      )
    ).rejects.toBeInstanceOf(Error)
    expect(dispatched).not.toHaveBeenCalled()
    expect(runtime.requestMethods).toEqual(['status.get'])
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it.each([
    'capable',
    'absent',
    'empty',
    'unrelated',
    'malformed',
    'failed',
    'disconnect',
    'after-send',
    'protocol',
    'auth'
  ] as const)(
    'preflights branch intent on the mutation socket after cached compatibility: %s',
    async (mode) => {
      const status: NonNullable<Parameters<typeof startTestRuntime>[1]> = {
        capabilities: ['worktree.remove-branch-policy.v1'],
        malformed: false,
        failure: false,
        disconnect: false,
        mutationDisconnect: false,
        rejectAuth: false,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION
      }
      const runtime = await startTestRuntime('removal', status)
      servers.push(runtime)
      const client = new RuntimeClient(
        '/tmp/unused',
        5000,
        encodePairingOffer({
          v: 2,
          endpoint: runtime.endpoint,
          deviceToken: runtime.deviceToken,
          publicKeyB64: runtime.publicKeyB64
        })
      )
      await client.getCliStatus()
      if (mode === 'absent') {
        status.capabilities = undefined
      }
      if (mode === 'empty') {
        status.capabilities = []
      }
      if (mode === 'unrelated') {
        status.capabilities = ['future.capability']
      }
      status.malformed = mode === 'malformed'
      const successful = ['capable', 'absent', 'empty', 'unrelated'].includes(mode)
      const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
      status.failure = mode === 'failed'
      status.disconnect = mode === 'disconnect'
      status.mutationDisconnect = mode === 'after-send'
      status.rejectAuth = mode === 'auth'
      if (mode === 'protocol') {
        status.runtimeProtocolVersion = 0
      }
      const removal = requestWorktreeRemoval(client, {
        worktree: 'id:task',
        hostId: 'local',
        force: false,
        deleteBranch: false,
        runHooks: false,
        allowFailedArchiveHook: false
      })
      await (successful
        ? expect(removal).resolves.toMatchObject({ result: { removed: true } })
        : expect(removal).rejects.toBeInstanceOf(Error))
      expect(
        warning.mock.calls.filter(([message]) => String(message).includes('host is older'))
      ).toHaveLength(successful && mode !== 'capable' ? 1 : 0)
      if (successful) {
        expect(runtime.requestParams.at(-1)).toEqual({
          worktree: 'id:task',
          hostId: 'local',
          force: false,
          runHooks: false,
          allowFailedArchiveHook: false,
          allowUnverifiedPtyStop: false,
          waitForBackgroundRemoval: true,
          ...(mode === 'capable' ? { deleteBranch: false } : {})
        })
      }
      warning.mockRestore()
      expect(runtime.connectionCount()).toBe(2)
      expect(runtime.requestMethods).toEqual(
        successful || mode === 'after-send'
          ? ['status.get', 'status.get', 'worktree.rm']
          : mode === 'auth'
            ? ['status.get']
            : ['status.get', 'status.get']
      )
    }
  )
})

async function startTestRuntime(
  runtimeId: string,
  statusOverrides: {
    runtimeProtocolVersion?: number
    minCompatibleRuntimeClientVersion?: number
    desktopWindowStatus?: 'available' | 'openable' | 'initializing' | 'blocked'
    appVersion?: string
    remoteUpdateSupport?: {
      installMode: 'unsupported-headless-serve'
      automatic: false
      reason: 'manual-service-update-required'
    }
    capabilities?: string[]
    malformed?: boolean
    failure?: boolean
    hold?: string
    onRequest?: (method: string) => void
    disconnect?: boolean
    mutationDisconnect?: boolean
    rejectAuth?: boolean
    degradations?: RuntimeStatus['degradations']
  } = {}
): Promise<TestRuntime> {
  const serverKeyPair = generateKeyPair()
  const deviceToken = `token-${runtimeId}`
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })
  const authFrames: Record<string, unknown>[] = []
  const requestMethods: string[] = []
  const requestParams: unknown[] = []
  let connectionCount = 0

  wss.on('connection', (ws) => {
    connectionCount += 1
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data) => {
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as Record<string, unknown> & {
          type?: string
          publicKeyB64?: string
        }
        const clientPublicKey = Buffer.from(hello.publicKeyB64 ?? '', 'base64')
        sharedKey = deriveSharedKey(serverKeyPair.secretKey, clientPublicKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (!plaintext) {
        ws.close(4003, 'decrypt failed')
        return
      }
      if (!authenticated) {
        const auth = JSON.parse(plaintext) as Record<string, unknown> & {
          type?: string
          deviceToken?: string
        }
        authFrames.push(auth)
        if (
          auth.type !== 'e2ee_auth' ||
          auth.deviceToken !== deviceToken ||
          statusOverrides.rejectAuth
        ) {
          ws.send(encrypt(JSON.stringify({ type: 'e2ee_error' }), sharedKey))
          ws.close(4001, 'auth failed')
          return
        }
        authenticated = true
        ws.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        return
      }

      const request: { id: string; method: string; params?: unknown } = JSON.parse(plaintext)
      requestMethods.push(request.method)
      requestParams.push(request.params)
      statusOverrides.onRequest?.(request.method)
      if (request.method === statusOverrides.hold) {
        return
      }
      if (request.method === 'status.get' && statusOverrides.disconnect) {
        ws.close()
        return
      }
      if (request.method === 'worktree.rm' && statusOverrides.mutationDisconnect) {
        ws.close()
        return
      }
      const response =
        request.method === 'status.get' && statusOverrides.failure
          ? {
              id: request.id,
              ok: false,
              error: { code: 'runtime_unavailable', message: 'status failed' },
              _meta: { runtimeId }
            }
          : request.method === 'worktree.rm'
            ? { id: request.id, ok: true, result: { removed: true }, _meta: { runtimeId } }
            : request.method === 'status.get'
              ? {
                  id: request.id,
                  ok: true,
                  result: statusOverrides.malformed
                    ? { capabilities: 42 }
                    : {
                        runtimeId,
                        rendererGraphEpoch: 1,
                        graphStatus: 'ready',
                        authoritativeWindowId: null,
                        desktopWindowStatus: statusOverrides.desktopWindowStatus,
                        liveTabCount: 0,
                        liveLeafCount: 0,
                        runtimeProtocolVersion:
                          statusOverrides.runtimeProtocolVersion ?? RUNTIME_PROTOCOL_VERSION,
                        minCompatibleRuntimeClientVersion:
                          statusOverrides.minCompatibleRuntimeClientVersion ??
                          MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                        appVersion: statusOverrides.appVersion,
                        remoteUpdateSupport: statusOverrides.remoteUpdateSupport,
                        capabilities: statusOverrides.capabilities,
                        degradations: statusOverrides.degradations
                      },
                  _meta: { runtimeId }
                }
              : {
                  id: request.id,
                  ok: false,
                  error: { code: 'method_not_found', message: 'Unknown method' },
                  _meta: { runtimeId }
                }
      ws.send(encrypt(JSON.stringify(response), sharedKey))
    })
  })

  await listen(httpServer)
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server')
  }

  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey),
    deviceToken,
    authFrames,
    requestMethods,
    requestParams,
    connectionCount: () => connectionCount,
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
        for (const client of wss.clients) {
          client.close()
        }
      })
      await closeHttpServer(httpServer)
    }
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
