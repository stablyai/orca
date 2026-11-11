import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E2EEChannel } from './e2ee-channel'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { createRemoteRuntimeClientHandshake } from '../../../shared/remote-runtime/remote-runtime-client-framing'
import {
  configureRemoteRuntimeE2EEV2HostLatch,
  REMOTE_RUNTIME_E2EE_V2_HOSTS_FILENAME
} from '../../../shared/remote-runtime/e2ee/node/remote-runtime-e2ee-v2-host-latch'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type * as AuthValidation from './mobile-e2ee-auth-validation'
import { E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/pairing/device-key-capability'

// Hosts released between v2 and capability-carrying v2 token auth refused the extra field.
const TOKEN_FOR_HOST_WITHOUT_V2_TOKEN_CAPABILITIES = 'device-token-v2-exact'
vi.mock('./mobile-e2ee-auth-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthValidation>()
  return {
    ...actual,
    authenticateMobileE2EE: (args: Parameters<typeof actual.authenticateMobileE2EE>[0]) => {
      const auth = JSON.parse(args.plaintext)
      return args.v2Session &&
        auth.deviceToken === TOKEN_FOR_HOST_WITHOUT_V2_TOKEN_CAPABILITIES &&
        auth.clientCapabilities !== undefined
        ? ({ ok: false, code: 'bad_auth' } as const)
        : actual.authenticateMobileE2EE(args)
    }
  }
})

type HostKind = 'current' | 'v2-without-token-capabilities' | 'pre-v2'
type TestHost = {
  connection: PairedRuntimeConnection
  authFramings: ('legacy' | 'v2')[]
  capabilities: unknown[]
  requests: string[]
  close: () => Promise<void>
}

const openHosts: TestHost[] = []
let userDataPath = ''

async function startHost(kind: HostKind, keyPair = nacl.box.keyPair()): Promise<TestHost> {
  const publicKeyB64 = Buffer.from(keyPair.publicKey).toString('base64')
  const token =
    kind === 'v2-without-token-capabilities'
      ? TOKEN_FOR_HOST_WITHOUT_V2_TOKEN_CAPABILITIES
      : 'device-token'
  const authFramings: TestHost['authFramings'] = []
  const capabilities: unknown[] = []
  const requests: string[] = []
  const hostCapabilities = kind.startsWith('current')
    ? [E2EE_V2_TOKEN_CAPABILITIES_RUNTIME_CAPABILITY]
    : []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (ws: WebSocket) => {
    let sawHello = false
    const channel = new E2EEChannel(ws, {
      serverSecretKey: keyPair.secretKey,
      resolveAuthenticatedDevice: (candidate) =>
        candidate === token
          ? {
              deviceId: 'device-1',
              scope: 'runtime',
              clientId: candidate,
              callerFingerprint: 'fingerprint',
              credentialRevision: 0,
              deviceToken: candidate
            }
          : null,
      onReady: (ready) => {
        authFramings.push(ready.transcriptHashB64 ? 'v2' : 'legacy')
        capabilities.push(ready.capabilitySource.current)
      },
      onError: (code, reason) => ws.close(code, reason)
    })
    channel.onMessage((plaintext, reply) => {
      const { id, method } = JSON.parse(plaintext)
      requests.push(`${method} over ${channel.transcriptHashB64 ? 'v2' : 'legacy'}`)
      const result = method === 'status.get' ? { capabilities: hostCapabilities } : 'pong'
      reply(JSON.stringify({ id, ok: true, result, _meta: { runtimeId: 'r' } }))
    })
    ws.on('message', (data: Buffer) => {
      const text = data.toString()
      if (!sawHello) {
        sawHello = true
        // A host from before v2 rejects a hello without a legacy public key.
        const refusesV2 = kind === 'pre-v2'
        if (refusesV2 && !JSON.parse(text).publicKeyB64) {
          ws.close(4001, 'Invalid e2ee_hello')
          return
        }
      }
      channel.handleRawMessage(text)
    })
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const host: TestHost = {
    connection: {
      endpoint: `ws://127.0.0.1:${port}`,
      hostPublicKeyB64: publicKeyB64,
      credential: { kind: 'token', deviceToken: token }
    },
    authFramings,
    capabilities,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const client of server.clients) {
          client.terminate()
        }
        server.close(() => resolve())
      })
  }
  openHosts.push(host)
  return host
}

function ping(host: TestHost): Promise<unknown> {
  return sendRemoteRuntimeRequestOnSocket(
    host.connection,
    'status.ping',
    undefined,
    5_000,
    undefined,
    undefined,
    undefined,
    ['test.capability.v1'],
    undefined,
    undefined
  ).then((response) => (response.ok ? response.result : response.error))
}

function latchedHosts(): string[] {
  return JSON.parse(readFileSync(join(userDataPath, REMOTE_RUNTIME_E2EE_V2_HOSTS_FILENAME), 'utf8'))
    .hosts
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-e2ee-v2-latch-'))
  configureRemoteRuntimeE2EEV2HostLatch(userDataPath)
})

afterEach(async () => {
  await Promise.all(openHosts.splice(0).map((host) => host.close()))
  configureRemoteRuntimeE2EEV2HostLatch(null)
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('remote runtime client E2EE framing', () => {
  it('authenticates a current host with v2, keeps capabilities, and remembers it', async () => {
    const host = await startHost('current')

    await expect(ping(host)).resolves.toBe('pong')
    await expect(ping(host)).resolves.toBe('pong')

    expect(host.authFramings).toEqual(['v2', 'v2'])
    expect(host.capabilities[0]).toContain('test.capability.v1')
    expect(latchedHosts()).toEqual([host.connection.hostPublicKeyB64])
    // Long-lived sockets now open with v2 as well.
    expect(createRemoteRuntimeClientHandshake(host.connection.hostPublicKeyB64).framing).toBe('v2')
  })

  it('falls back to legacy for a host from before v2 without failing the request', async () => {
    const host = await startHost('pre-v2')

    await expect(ping(host)).resolves.toBe('pong')
    await expect(ping(host)).resolves.toBe('pong')

    expect(host.authFramings).toEqual(['legacy', 'legacy'])
    expect(host.capabilities[0]).toContain('test.capability.v1')
    expect(createRemoteRuntimeClientHandshake(host.connection.hostPublicKeyB64).framing).toBe(
      'legacy'
    )
  })

  it('falls back to legacy for a v2 host that refuses capabilities on token auth', async () => {
    const host = await startHost('v2-without-token-capabilities')

    await expect(ping(host)).resolves.toBe('pong')

    expect(host.authFramings).toEqual(['legacy'])
    expect(host.capabilities[0]).toContain('test.capability.v1')
  })

  it('keeps a latched host working over legacy once the host itself shows it was downgraded', async () => {
    const keyPair = nacl.box.keyPair()
    const current = await startHost('current', keyPair)
    await expect(ping(current)).resolves.toBe('pong')
    await current.close()

    const downgraded = await startHost('pre-v2', keyPair)
    await expect(ping(downgraded)).resolves.toBe('pong')

    expect(downgraded.requests).toEqual(['status.get over legacy', 'status.ping over legacy'])
    expect(latchedHosts()).toEqual([])
  })
})
