import { addEnvironmentFromPairingCode } from './environments'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../main/browser/electron-fixtures/browser-local-https-test-certificate'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'

import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from '../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import './websocket-transport'
import '../../shared/remote-runtime/requests/remote-runtime-prepared-request-admission'
import { RuntimeClient } from './client'
import '../handlers/worktree-removal-request'
import { launchOrcaApp } from './launch'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'

vi.mock('./launch', () => ({
  launchOrcaApp: vi.fn()
}))

type TestRuntime = {
  endpoint: string
  publicKeyB64: string
  deviceToken: string
  observedHeaders: Record<string, string | string[] | undefined>[]
  authFrames: Record<string, unknown>[]
  requestMethods: string[]
  requestParams: unknown[]
  connectionCount: () => number
  close: () => Promise<void>
}

describe('CLI remote WebSocket transport', () => {
  const servers: TestRuntime[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.mocked(launchOrcaApp).mockClear()
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it.each(['pairing code', 'saved environment'])(
    'uses private-file headers for a TLS %s connection without adding them to Orca auth frames',
    async (mode) => {
      const previousCAs = getCACertificates('default')
      setDefaultCACertificates([...previousCAs, LOCAL_HTTPS_TEST_CERTIFICATE])
      const directory = mkdtempSync(join(tmpdir(), 'orca-cli-edge-tls-'))
      try {
        const runtime = await startTestRuntime('runtime-edge', { secure: true })
        servers.push(runtime)
        const code = encodePairingOffer({
          v: 2,
          endpoint: runtime.endpoint,
          deviceToken: runtime.deviceToken,
          publicKeyB64: runtime.publicKeyB64
        })
        const path = join(directory, 'edge.json')
        writeSecureFile(
          path,
          JSON.stringify({
            v: 1,
            origin: new URL(runtime.endpoint).origin,
            hostPublicKeyB64: runtime.publicKeyB64,
            headers: [{ name: 'CF-Access-Client-Secret', value: 'synthetic-edge-secret' }]
          })
        )
        vi.stubEnv('ORCA_REMOTE_AUTH_FILE', path)
        if (mode === 'saved environment') {
          addEnvironmentFromPairingCode(directory, { name: 'edge', pairingCode: code })
        }
        const client = new RuntimeClient(
          directory,
          5000,
          mode === 'pairing code' ? code : null,
          mode === 'saved environment' ? 'edge' : null
        )
        expect((await client.getCliStatus()).result.runtime.runtimeId).toBe('runtime-edge')
        expect(runtime.observedHeaders[0]?.['cf-access-client-secret']).toBe(
          'synthetic-edge-secret'
        )
        expect(JSON.stringify(runtime.authFrames)).not.toContain('synthetic-edge-secret')
      } finally {
        setDefaultCACertificates(previousCAs)
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

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
})

async function startTestRuntime(
  runtimeId: string,
  statusOverrides: {
    secure?: boolean
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
  const httpServer = statusOverrides.secure
    ? createHttpsServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
    : createServer()
  const wss = new WebSocketServer({ server: httpServer })
  const observedHeaders: Record<string, string | string[] | undefined>[] = []
  const authFrames: Record<string, unknown>[] = []
  const requestMethods: string[] = []
  const requestParams: unknown[] = []
  let connectionCount = 0

  wss.on('connection', (ws, request) => {
    observedHeaders.push(request.headers)
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data) => {
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as Record<string, unknown> & {
          type?: string
          publicKeyB64?: string
        }
        if (!hello.publicKeyB64) {
          // Legacy-only host: refuses a v2 hello the way hosts before v2 do.
          ws.close(4001, 'Invalid e2ee_hello')
          return
        }
        connectionCount += 1
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
    endpoint: `${statusOverrides.secure ? 'wss' : 'ws'}://127.0.0.1:${address.port}`,
    publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey),
    deviceToken,
    observedHeaders,
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
