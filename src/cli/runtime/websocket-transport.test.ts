import { createServer, type Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from '../../shared/e2ee-crypto'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { RuntimeClientError } from './types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'

type TestRuntime = {
  endpoint: string
  publicKeyB64: string
  deviceToken: string
  close: () => Promise<void>
}

describe('CLI remote WebSocket transport', () => {
  const servers: TestRuntime[] = []

  afterEach(async () => {
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

    expect(response.ok).toBe(true)
    expect(response.result.runtimeId).toBe('runtime-ws-1')
  })

  it('rejects malformed remote pairing codes before local runtime lookup', () => {
    expect(() => new RuntimeClient('/tmp/unused', 5_000, 'not-a-pairing-code')).toThrow(
      RuntimeClientError
    )
  })

  it('accepts a bare pairing payload as well as the orca URL wrapper', async () => {
    const runtime = await startTestRuntime('runtime-ws-2')
    servers.push(runtime)
    const offer: PairingOffer = {
      v: 2,
      endpoint: runtime.endpoint,
      deviceToken: runtime.deviceToken,
      publicKeyB64: runtime.publicKeyB64
    }
    const barePayload = encodePairingOffer(offer).split('#')[1]!

    const client = new RuntimeClient('/tmp/unused', 5_000, barePayload)
    const status = await client.getCliStatus()

    expect(status.result.runtime.reachable).toBe(true)
    expect(status.result.runtime.runtimeId).toBe('runtime-ws-2')
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
  })
})

async function startTestRuntime(
  runtimeId: string,
  statusOverrides: {
    runtimeProtocolVersion?: number
    minCompatibleRuntimeClientVersion?: number
  } = {}
): Promise<TestRuntime> {
  const serverKeyPair = generateKeyPair()
  const deviceToken = `token-${runtimeId}`
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', (data) => {
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { type?: string; publicKeyB64?: string }
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
        const auth = JSON.parse(plaintext) as { type?: string; deviceToken?: string }
        if (auth.type !== 'e2ee_auth' || auth.deviceToken !== deviceToken) {
          ws.send(encrypt(JSON.stringify({ type: 'e2ee_error' }), sharedKey))
          ws.close(4001, 'auth failed')
          return
        }
        authenticated = true
        ws.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        return
      }

      const request = JSON.parse(plaintext) as { id: string; method: string }
      const response =
        request.method === 'status.get'
          ? {
              id: request.id,
              ok: true,
              result: {
                runtimeId,
                rendererGraphEpoch: 1,
                graphStatus: 'ready',
                authoritativeWindowId: null,
                liveTabCount: 0,
                liveLeafCount: 0,
                runtimeProtocolVersion:
                  statusOverrides.runtimeProtocolVersion ?? RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion:
                  statusOverrides.minCompatibleRuntimeClientVersion ??
                  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
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
