import { afterEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import {
  FileReadCapExceededError,
  readFileViaStream,
  StreamProtocolError
} from './ssh-filesystem-stream-reader'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
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

function sendForeignFrames(connection: ReturnType<typeof createConnection>): WeakRef<object>[] {
  const refs: WeakRef<object>[] = []
  const stop = connection.mux.onNotificationByMethod('fs.streamChunk', (params) => {
    refs.push(new WeakRef(params))
  })
  for (let index = 0; index < 64; index += 1) {
    connection.feed({
      jsonrpc: '2.0',
      method: 'fs.streamChunk',
      params: { streamId: index + 10, seq: 0, data: 'eA==' }
    })
  }
  stop()
  return refs
}

it('releases foreign stream frames while its own metadata is still pending', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/held.txt')
  const refs = sendForeignFrames(connection)
  try {
    expect(refs).toHaveLength(64)
    await collect()
    expect(refs.filter((ref) => ref.deref())).toHaveLength(0)
    expect(connection.sent).toHaveLength(1)
  } finally {
    connection.feed({
      jsonrpc: '2.0',
      id: 1,
      result: { empty: true, totalSize: 0, isBinary: false }
    })
    await pending
  }
})

it('installs metadata before its own chunk and end in the same decoder turn', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/own.txt')
  const text = 'same turn 漢\u0000'
  const data = Buffer.from(text)
  connection.feed(
    {
      jsonrpc: '2.0',
      id: 1,
      result: { streamId: 3, totalSize: data.length, isBinary: false, resultEncoding: 'utf-8' }
    },
    {
      jsonrpc: '2.0',
      method: 'fs.streamChunk',
      params: { streamId: 3, seq: 0, data: data.toString('base64') }
    },
    { jsonrpc: '2.0', method: 'fs.streamEnd', params: { streamId: 3 } }
  )
  await expect(pending).resolves.toEqual({ content: text, isBinary: false })
  expect(connection.sent).toContainEqual({
    jsonrpc: '2.0',
    method: 'fs.streamAck',
    params: { streamId: 3, seq: 0 }
  })
})

it('preserves empty image metadata while ignoring earlier unknown stream identifiers', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/empty.png')
  connection.feed(
    { jsonrpc: '2.0', method: 'fs.streamChunk', params: { streamId: -1, seq: 0, data: 'eA==' } },
    {
      jsonrpc: '2.0',
      id: 1,
      result: { empty: true, totalSize: 0, isBinary: true, isImage: true, mimeType: 'image/png' }
    }
  )
  await expect(pending).resolves.toEqual({
    content: '',
    isBinary: true,
    isImage: true,
    mimeType: 'image/png'
  })
  expect(connection.sent).toHaveLength(1)
})

it('rejects metadata missing its stream identifier', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/invalid.txt')
  connection.feed({ jsonrpc: '2.0', id: 1, result: { totalSize: 1, isBinary: false } })
  await expect(pending).rejects.toBeInstanceOf(StreamProtocolError)
  expect(connection.sent).toHaveLength(1)
})

it.each([-1, 51 * 1024 * 1024])(
  'rejects invalid or oversized totalSize %d and cancels the identified stream',
  async (totalSize) => {
    const connection = createConnection()
    const pending = readFileViaStream(connection.mux, '/invalid.png')
    connection.feed({ jsonrpc: '2.0', id: 1, result: { streamId: 3, totalSize, isBinary: true } })
    await expect(pending).rejects.toBeInstanceOf(FileReadCapExceededError)
    expect(connection.sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'fs.cancelStream',
      params: { streamId: 3 }
    })
  }
)

it('preserves a tighter caller cap before accepting adjacent data', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/small.txt', { maxTextBytes: 1 })
  connection.feed(
    { jsonrpc: '2.0', id: 1, result: { streamId: 3, totalSize: 2, isBinary: false } },
    { jsonrpc: '2.0', method: 'fs.streamChunk', params: { streamId: 3, seq: 0, data: 'eHg=' } }
  )
  await expect(pending).rejects.toBeInstanceOf(FileReadCapExceededError)
  expect(connection.sent).toHaveLength(2)
})

it('preserves an adjacent own-stream error after metadata', async () => {
  const connection = createConnection()
  const pending = readFileViaStream(connection.mux, '/removed.txt')
  connection.feed(
    { jsonrpc: '2.0', id: 1, result: { streamId: 3, totalSize: 1, isBinary: false } },
    {
      jsonrpc: '2.0',
      method: 'fs.streamError',
      params: { streamId: 3, code: 'ENOENT', message: 'gone' }
    }
  )
  await expect(pending).rejects.toMatchObject({ code: 'ENOENT', message: 'gone' })
})

it('preserves the provider fallback when an older relay has no streaming method', async () => {
  const connection = createConnection()
  const provider = new SshFilesystemProvider('test', connection.mux)
  const pending = provider.readFile('/legacy.txt')
  try {
    connection.feed({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(connection.sent).toContainEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'fs.readFile',
      params: { filePath: '/legacy.txt' }
    })
    connection.feed({ jsonrpc: '2.0', id: 2, result: { content: 'legacy', isBinary: false } })
    await expect(pending).resolves.toEqual({ content: 'legacy', isBinary: false })
  } finally {
    provider.dispose()
  }
})

// Why: the metadata install moved from the mandatory resolve path to the optional
// beforeResolve hook, and the request timer is cleared before that hook runs. A mux
// that ignores the hook must fail the read, not leave it pending with no deadline.
it('fails the read when a multiplexer resolves without running beforeResolve', async () => {
  const connection = createConnection()
  vi.spyOn(connection.mux, 'request').mockResolvedValue({
    totalSize: 10,
    isBinary: false,
    streamId: 7
  })

  await expect(readFileViaStream(connection.mux, '/no-hook.txt')).rejects.toBeInstanceOf(
    StreamProtocolError
  )
})
