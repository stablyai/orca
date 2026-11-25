import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { E2EEChannel } from './e2ee-channel'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { readRuntimeRpcStagedReply } from '../../../../../shared/remote-runtime/requests/runtime-rpc-staged-reply-read'
import {
  RUNTIME_RPC_READ_STAGED_REPLY_METHOD,
  type RuntimeRpcStagedReplyPart
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-staged-reply'
import type { RuntimeRequestSelection } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { configureRemoteRuntimeE2EEV2HostLatch } from '../../../../../shared/remote-runtime/e2ee/node/remote-runtime-e2ee-v2-host-latch'
import type { PairedRuntimeConnection } from '../../../../../shared/remote-runtime/pairing/paired-runtime-connection'

type Host = {
  connection: PairedRuntimeConnection
  frames: Record<string, unknown>[]
  close: () => Promise<void>
}
type HostMode = 'stall' | 'hold-status' | 'lose-reply' | 'respond' | 'stage-reply' | 'old-runtime'

const params = { type: 'worker_done', from: 'term_worker', subject: 'Done' }
const envelope = { orchestrationRequestId: 'mutation_1', orchestrationCapability: 'test-proof' }

const openHosts: Host[] = []
let userDataPath = ''

async function startHost(...modes: HostMode[]): Promise<Host> {
  const keyPair = nacl.box.keyPair()
  const frames: Record<string, unknown>[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (ws: WebSocket) => {
    const mode = modes.shift()
    if (mode === 'stall') {
      return
    }
    const channel = new E2EEChannel(ws, {
      serverSecretKey: keyPair.secretKey,
      resolveAuthenticatedDevice: (candidate) =>
        candidate === 'device-token'
          ? {
              deviceId: 'device-1',
              scope: 'runtime',
              clientId: candidate,
              callerFingerprint: 'fingerprint',
              credentialRevision: 0,
              deviceToken: candidate
            }
          : null,
      onError: (code, reason) => ws.close(code, reason),
      onReady: () => {}
    })
    channel.onMessage((plaintext, reply) => {
      const frame: Record<string, unknown> = JSON.parse(plaintext)
      frames.push(frame)
      const meta = { id: frame.id, _meta: { runtimeId: 'r' } }
      if (frame.method === 'status.get') {
        // Authenticated and holding the same connection's status request: the mutation never goes.
        if (mode === 'hold-status') {
          return
        }
        const capabilities = mode === 'old-runtime' ? [] : ['orchestration.replay-only-retry.v1']
        reply(JSON.stringify({ ...meta, ok: true, result: { capabilities } }))
      } else if (mode === 'respond') {
        reply(JSON.stringify({ ...meta, ok: true, result: { sent: true } }))
      } else if (mode === 'stage-reply') {
        reply(
          JSON.stringify({
            ...meta,
            ok: false,
            error: {
              code: 'reply_staged',
              message: 'Staged',
              data: { replyId: 'reply', length: 1 }
            }
          })
        )
      }
    })
    ws.on('message', (data: Buffer) => channel.handleRawMessage(data.toString()))
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const host: Host = {
    connection: {
      endpoint: `ws://127.0.0.1:${port}`,
      hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
      credential: { kind: 'token', deviceToken: 'device-token' }
    },
    frames,
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

function send(host: Host) {
  return sendRemoteRuntimeRequestOnSocket(host.connection, 'orchestration.send', params, 2_000, {
    ...envelope,
    orchestrationContractVersion: 1
  })
}

function replay(host: Host, requestSelection: RuntimeRequestSelection) {
  return sendRemoteRuntimeRequestOnSocket(
    host.connection,
    'orchestration.send',
    params,
    2_000,
    { ...envelope, orchestrationContractVersion: 2 },
    () => {},
    undefined,
    [],
    requestSelection
  )
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-request-custody-'))
  configureRemoteRuntimeE2EEV2HostLatch(userDataPath)
})

afterEach(async () => {
  await Promise.all(openHosts.splice(0).map((host) => host.close()))
  configureRemoteRuntimeE2EEV2HostLatch(null)
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('a paired request that times out', () => {
  it('marks a pre-frame timeout unsent so the next request can be an ordinary send', async () => {
    const host = await startHost('stall', 'respond')

    await expect(send(host)).rejects.toMatchObject({
      code: 'runtime_timeout',
      data: { requestSent: false }
    })
    expect(host.frames).toEqual([])
    await expect(send(host)).resolves.toMatchObject({ ok: true })
    expect(host.frames).toMatchObject([
      { method: 'orchestration.send', params, ...envelope, orchestrationContractVersion: 1 }
    ])
  })

  it('keeps the key, payload and authority when replaying after a frame was written', async () => {
    const host = await startHost('lose-reply', 'respond')

    const error = await send(host).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'runtime_timeout' })
    expect(error).not.toHaveProperty('data.requestSent')
    await expect(replay(host, { paramsForStatus: () => params })).resolves.toMatchObject({
      ok: true
    })

    expect(host.frames).toMatchObject([
      { method: 'orchestration.send', params, ...envelope, orchestrationContractVersion: 1 },
      { method: 'status.get' },
      { method: 'orchestration.send', params, ...envelope, orchestrationContractVersion: 2 }
    ])
    expect(new Set(host.frames.map(({ id }) => id)).size).toBe(3)
  })

  it('marks a timeout unsent when an authenticated host withholds the status reply before the mutation', async () => {
    const host = await startHost('hold-status')

    await expect(replay(host, { paramsForStatus: () => params })).rejects.toMatchObject({
      code: 'runtime_timeout',
      data: { requestSent: false }
    })

    expect(host.frames.map((frame) => frame.method)).toEqual(['status.get'])
    expect(host.frames[0]).not.toHaveProperty('orchestrationRequestId')
  })

  it('keeps a timeout after the mutation frame ambiguous at the same authenticated stage', async () => {
    const host = await startHost('lose-reply')

    const error = await replay(host, { paramsForStatus: () => params }).catch(
      (failure: unknown) => failure
    )

    expect(error).toMatchObject({ code: 'runtime_timeout' })
    expect(error).not.toHaveProperty('data.requestSent')
    expect(host.frames).toMatchObject([
      { method: 'status.get' },
      { method: 'orchestration.send', params, ...envelope, orchestrationContractVersion: 2 }
    ])
  })

  it('sends only a clean status preflight to a runtime without replay support', async () => {
    const host = await startHost('old-runtime')

    await expect(
      replay(host, {
        paramsForStatus: (status) => {
          expect(status).toMatchObject({ capabilities: [] })
          throw new Error('Replay requires a capable runtime')
        }
      })
    ).rejects.toThrow('Replay requires a capable runtime')

    expect(host.frames.map((frame) => frame.method)).toEqual(['status.get'])
    expect(host.frames[0]).not.toHaveProperty('orchestrationContractVersion')
    expect(host.frames[0]).not.toHaveProperty('orchestrationRequestId')
    expect(host.frames[0]).not.toHaveProperty('orchestrationCapability')
  })

  it('keeps the parent possibly delivered when the staged reply read never sends', async () => {
    const host = await startHost('stage-reply', 'stall')

    const response = await send(host)
    const error = await readRuntimeRpcStagedReply(response, (part) =>
      sendRemoteRuntimeRequestOnSocket<RuntimeRpcStagedReplyPart>(
        host.connection,
        RUNTIME_RPC_READ_STAGED_REPLY_METHOD,
        part,
        2_000
      )
    ).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'runtime_timeout' })
    expect(error).not.toHaveProperty('data.requestSent')
    expect(host.frames.map((frame) => frame.method)).toEqual(['orchestration.send'])
  })
})
