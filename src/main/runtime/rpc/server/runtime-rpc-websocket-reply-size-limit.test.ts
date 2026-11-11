import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './pairing/device-registry'
import { FILE_METHODS } from '../methods/files/files'
import { E2EEChannel } from '../e2ee-channel'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair
} from '../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'

import { RUNTIME_RPC_REPLY_TOO_LARGE_CODE } from './runtime-rpc-reply-size-limit'

function createServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-reply-size-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    methods: FILE_METHODS,
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const device = server['deviceRegistry'].addDevice('paired-desktop', 'runtime')
  return { runtime, server, device }
}

/** Routes the server's replies through a real, authenticated E2EE channel, as a paired client sees them. */
function connectEncryptedChannel() {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const sent: string[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn()
  }
  const onError = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: E2EEChannel only reads OPEN/readyState and calls send/close, all provided.
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) => ({
      deviceId: 'd',
      deviceToken: token,
      scope: 'runtime',
      clientId: token,
      callerFingerprint: 'test-fingerprint',
      credentialRevision: 0
    }),
    onReady: vi.fn(),
    onError
  })
  channel.handleRawMessage(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64')
    })
  )
  const sharedKey = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
  channel.handleRawMessage(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'tok' }), sharedKey)
  )
  const handshakeFrames = sent.length
  return {
    channel,
    sharedKey,
    onError,
    replies: () =>
      sent
        .slice(handshakeFrames)
        .map((frame): unknown => JSON.parse(decrypt(frame, sharedKey) ?? 'null'))
  }
}

describe('remote RPC replies over the encrypted channel', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    vi.restoreAllMocks()
  })

  it('answers any other oversized reply with a per-request error', async () => {
    const { server, device } = createServer()
    servers.push(server)
    vi.spyOn(server['dispatcher'], 'dispatchStreaming').mockImplementation(
      async (request, reply) => {
        reply(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
          })
        )
      }
    )
    const encrypted = connectEncryptedChannel()
    encrypted.channel.onMessage((plaintext, reply, sendBinary) => {
      void server['handleWebSocketMessage'](
        plaintext,
        reply,
        sendBinary,
        undefined,
        undefined,
        device.token
      )
    })

    encrypted.channel.handleRawMessage(
      encrypt(
        JSON.stringify({ id: 'big', method: 'agentSessions.list', params: {} }),
        encrypted.sharedKey
      )
    )
    await vi.waitFor(() => expect(encrypted.replies()).toHaveLength(1))

    expect(encrypted.onError).not.toHaveBeenCalled()
    expect(encrypted.replies()[0]).toMatchObject({
      id: 'big',
      ok: false,
      error: { code: RUNTIME_RPC_REPLY_TOO_LARGE_CODE }
    })
  })
})
