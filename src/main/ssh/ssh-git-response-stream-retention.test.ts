import { afterEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { GitResponseStreamError, requestGitStreamable } from './ssh-git-response-stream-reader'
import {
  encodeJsonRpcFrame,
  MessageType,
  parseJsonRpcMessage,
  type JsonRpcMessage
} from './relay-protocol'

const muxes: SshChannelMultiplexer[] = []
afterEach(() => {
  for (const mux of muxes.splice(0)) {
    mux.dispose()
  }
})

function createConnection() {
  let receive = (_data: Buffer): void => {}
  let sequence = 1
  const sent: JsonRpcMessage[] = []
  const mux = new SshChannelMultiplexer({
    write(data) {
      if (data[0] === MessageType.Regular) {
        sent.push(parseJsonRpcMessage(data.subarray(13)))
      }
    },
    onData(callback) {
      receive = callback
    },
    onClose() {}
  })
  muxes.push(mux)
  return {
    mux,
    sent,
    feed(...messages: JsonRpcMessage[]) {
      receive(Buffer.concat(messages.map((message) => encodeJsonRpcFrame(message, sequence++, 0))))
    }
  }
}

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('Retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

it('releases foreign stream frames while its own sentinel is still pending', async () => {
  const connection = createConnection()
  const pending = requestGitStreamable(connection.mux, 'git.diff', { cwd: '/repo' })
  const refs: WeakRef<object>[] = []
  const stop = connection.mux.onNotificationByMethod('git.responseChunk', (params) => {
    refs.push(new WeakRef(params))
  })
  for (let index = 0; index < 64; index += 1) {
    connection.feed({
      jsonrpc: '2.0',
      method: 'git.responseChunk',
      params: { streamId: index + 10, seq: 0, data: 'eA==' }
    })
  }
  stop()
  try {
    expect(refs).toHaveLength(64)
    await collect()
    expect(refs.filter((ref) => ref.deref())).toHaveLength(0)
    expect(connection.sent).toHaveLength(1)
  } finally {
    connection.feed({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    await pending
  }
})

it('installs the stream identity before its own chunk and end in the same decoder turn', async () => {
  const connection = createConnection()
  const pending = requestGitStreamable(connection.mux, 'git.diff', { cwd: '/repo' })
  const payload = Buffer.from(JSON.stringify({ diff: 'same turn' }))
  connection.feed(
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        __orcaGitResponseStream: { streamId: 3, totalBytes: payload.length, chunkCount: 1 }
      }
    },
    {
      jsonrpc: '2.0',
      method: 'git.responseChunk',
      params: { streamId: 3, seq: 0, data: payload.toString('base64') }
    },
    { jsonrpc: '2.0', method: 'git.responseEnd', params: { streamId: 3 } }
  )
  await expect(pending).resolves.toEqual({ diff: 'same turn' })
  expect(connection.sent).toContainEqual({
    jsonrpc: '2.0',
    method: 'git.responseAck',
    params: { streamId: 3, seq: 0 }
  })
})

it('drops foreign frames instead of buffering them while the sentinel is pending', async () => {
  const connection = createConnection()
  const pending = requestGitStreamable(connection.mux, 'git.diff', { cwd: '/repo' })
  const payload = Buffer.from(JSON.stringify({ ok: 1 }))
  connection.feed(
    // Why: a frame that arrives before the sentinel installs our streamId is
    // foreign by definition — dropped, not queued for a later drain.
    {
      jsonrpc: '2.0',
      method: 'git.responseChunk',
      params: { streamId: 99, seq: 0, data: 'AAAA' }
    },
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        __orcaGitResponseStream: { streamId: 3, totalBytes: payload.length, chunkCount: 1 }
      }
    },
    {
      jsonrpc: '2.0',
      method: 'git.responseChunk',
      params: { streamId: 3, seq: 0, data: payload.toString('base64') }
    },
    { jsonrpc: '2.0', method: 'git.responseEnd', params: { streamId: 3 } }
  )
  await expect(pending).resolves.toEqual({ ok: 1 })
})

it('resolves a plain result directly when the relay does not stream', async () => {
  const connection = createConnection()
  const pending = requestGitStreamable(connection.mux, 'git.status', { cwd: '/repo' })
  connection.feed({ jsonrpc: '2.0', id: 1, result: { branch: 'main' } })
  await expect(pending).resolves.toEqual({ branch: 'main' })
})

// Why: the identity install moved from the mandatory resolve path to the optional
// beforeResolve hook, and the request timer is cleared before that hook runs. A mux
// that ignores the hook must fail the read, not leave it pending with no deadline.
it('fails the read when a multiplexer resolves without running beforeResolve', async () => {
  const connection = createConnection()
  vi.spyOn(connection.mux, 'request').mockResolvedValue({
    __orcaGitResponseStream: { streamId: 7, totalBytes: 4, chunkCount: 1 }
  })

  await expect(
    requestGitStreamable(connection.mux, 'git.diff', { cwd: '/repo' })
  ).rejects.toBeInstanceOf(GitResponseStreamError)
})
