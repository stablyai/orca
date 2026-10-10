import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { E2EEChannel } from './rpc/e2ee-channel'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime-memory-limits'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import { RUNTIME_RPC_REPLY_TOO_LARGE_CODE } from './runtime-rpc/runtime-rpc-reply-size-limit'

// The HH-2 folder: 80,000 files serialize past the 4 MiB encrypted-reply cap.
function hugeListing(): DirEntry[] {
  return Array.from({ length: 80_000 }, (_, index) => ({
    name: `file-${String(index).padStart(5, '0')}.txt`,
    isDirectory: false,
    isSymlink: false
  }))
}

function createServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-reply-size-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
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
      scope: 'runtime'
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

  it('answers an oversized folder listing with an error instead of closing the connection', async () => {
    const { runtime, server, device } = createServer()
    servers.push(server)
    vi.spyOn(runtime, 'readFileExplorerDir').mockResolvedValue(hugeListing())
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
        JSON.stringify({
          id: 'read-flat',
          method: 'files.readDir',
          params: { worktree: 'id:wt-1', relativePath: 'flat' }
        }),
        encrypted.sharedKey
      )
    )
    await vi.waitFor(() => expect(encrypted.replies()).toHaveLength(1))

    expect(encrypted.onError).not.toHaveBeenCalled()
    expect(encrypted.replies()[0]).toMatchObject({
      id: 'read-flat',
      ok: false,
      error: {
        message: 'This folder has 80,000 entries, too many to list over a remote connection.'
      }
    })
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
