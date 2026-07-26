import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_GIT_RESPONSE_STREAM_BYTES,
  MAX_GIT_RESPONSE_STREAM_CHUNKS,
  STREAM_CHUNK_SIZE,
  MessageType,
  encodeFrame
} from './relay-protocol'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { readFileViaStream } from './ssh-filesystem-stream-reader'
import { requestGitStreamable } from './ssh-git-response-stream-reader'
import {
  MAX_PRE_METADATA_STREAM_ENCODED_BYTES,
  PreMetadataStreamFrameBuffer,
  SshPreMetadataStreamBudget,
  SshStreamAssemblyBudget
} from './ssh-stream-reader-memory'

type Notification = { method: string; params: Record<string, unknown> | undefined }

function createStreamMux(): {
  mux: Record<string, unknown>
  emit: (method: string, params: Record<string, unknown>) => void
  resolveRequest: (value: unknown) => void
  rejectRequest: (error: Error) => void
  dispose: (reason: 'shutdown' | 'connection_lost') => void
  notifications: Notification[]
} {
  const handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const disposeHandlers = new Set<(reason: 'shutdown' | 'connection_lost') => void>()
  const notifications: Notification[] = []
  let resolveRequest!: (value: unknown) => void
  let rejectRequest!: (error: Error) => void
  const requestPromise = new Promise<unknown>((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })
  const mux = {
    request: vi.fn(() => requestPromise),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    onNotificationByMethod: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        const current = handlers.get(method) ?? new Set()
        current.add(handler)
        handlers.set(method, current)
        return () => current.delete(handler)
      }
    ),
    onDispose: vi.fn((handler: (reason: 'shutdown' | 'connection_lost') => void) => {
      disposeHandlers.add(handler)
      return () => disposeHandlers.delete(handler)
    }),
    isDisposed: vi.fn(() => false)
  }
  return {
    mux,
    emit: (method, params) => {
      for (const handler of handlers.get(method) ?? []) {
        handler(params)
      }
    },
    resolveRequest,
    rejectRequest,
    dispose: (reason) => {
      for (const handler of disposeHandlers) {
        handler(reason)
      }
    },
    notifications
  }
}

async function flushRequestResolution(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function encodeMuxResponse(requestId: number, result: unknown, sequence: number): Buffer {
  return encodeFrame(
    MessageType.Regular,
    sequence,
    0,
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }))
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSH stream assembly aggregate budget', () => {
  it('bounds concurrent reservations and releases them idempotently', () => {
    const budget = new SshStreamAssemblyBudget(10)
    const releaseSix = budget.reserve(6)
    const releaseFour = budget.reserve(4)

    expect(releaseSix).not.toBeNull()
    expect(releaseFour).not.toBeNull()
    expect(budget.reserve(1)).toBeNull()
    expect(budget.retainedBytes).toBe(10)

    releaseSix?.()
    releaseSix?.()
    expect(budget.retainedBytes).toBe(4)
    expect(budget.reserve(6)).not.toBeNull()
  })
})

describe('SSH pre-metadata stream aggregate budget', () => {
  it('bounds concurrent frame buffers by count and bytes', () => {
    const budget = new SshPreMetadataStreamBudget(2, 5)
    const first = new PreMetadataStreamFrameBuffer(budget)
    const second = new PreMetadataStreamFrameBuffer(budget)
    const third = new PreMetadataStreamFrameBuffer(budget)

    expect(first.push({ kind: 'chunk', params: { streamId: 1, seq: 0, data: 'abc' } })).toBe(true)
    expect(second.push({ kind: 'chunk', params: { streamId: 2, seq: 0, data: 'de' } })).toBe(true)
    expect(third.push({ kind: 'end', params: { streamId: 3 } })).toBe(false)
    expect(budget.retainedFrames).toBe(2)
    expect(budget.retainedBytes).toBe(5)

    first.clear()
    expect(third.push({ kind: 'end', params: { streamId: 3 } })).toBe(true)
    expect(budget.retainedFrames).toBe(2)
    second.clear()
    third.clear()
    expect(budget.retainedFrames).toBe(0)
    expect(budget.retainedBytes).toBe(0)
  })

  it('releases shared reservations on success, stream error, request timeout, and disconnect', async () => {
    const budget = new SshPreMetadataStreamBudget(4, 64)
    const fileHarness = createStreamMux()
    const errorHarness = createStreamMux()
    const gitHarness = createStreamMux()
    const disconnectHarness = createStreamMux()
    const fileResult = readFileViaStream(
      fileHarness.mux as never,
      'empty.txt',
      undefined,
      new SshStreamAssemblyBudget(1),
      budget
    )
    const errorResult = readFileViaStream(
      errorHarness.mux as never,
      'error.txt',
      undefined,
      new SshStreamAssemblyBudget(1),
      budget
    )
    const gitResult = requestGitStreamable(
      gitHarness.mux as never,
      'git.diff',
      {},
      undefined,
      new SshStreamAssemblyBudget(1),
      budget
    )
    const disconnectResult = readFileViaStream(
      disconnectHarness.mux as never,
      'disconnected.txt',
      undefined,
      new SshStreamAssemblyBudget(1),
      budget
    )
    fileHarness.emit('fs.streamEnd', { streamId: 1 })
    errorHarness.emit('fs.streamError', { streamId: 2, message: 'remote read failed' })
    gitHarness.emit('git.responseEnd', { streamId: 3 })
    disconnectHarness.emit('fs.streamEnd', { streamId: 4 })
    expect(budget.retainedFrames).toBe(4)

    const streamRejection = expect(errorResult).rejects.toThrow('remote read failed')
    const gitRejection = expect(gitResult).rejects.toThrow(/timed out/)
    const disconnectRejection = expect(disconnectResult).rejects.toMatchObject({
      code: 'CONNECTION_LOST'
    })
    fileHarness.resolveRequest({ streamId: 1, totalSize: 0, isBinary: false })
    errorHarness.resolveRequest({ streamId: 2, totalSize: 1, isBinary: false })
    gitHarness.rejectRequest(new Error('Request "git.diff" timed out after 30ms'))
    disconnectHarness.dispose('connection_lost')

    await expect(fileResult).resolves.toEqual({ content: '', isBinary: false })
    await streamRejection
    await gitRejection
    await disconnectRejection
    expect(budget.retainedFrames).toBe(0)
    expect(budget.retainedBytes).toBe(0)
  })
})

describe('SSH Git response stream memory bounds', () => {
  it('rejects and cancels an oversized stream marker', async () => {
    const harness = createStreamMux()
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {})
    harness.resolveRequest({
      __orcaGitResponseStream: {
        streamId: 7,
        totalBytes: MAX_GIT_RESPONSE_STREAM_BYTES + 1,
        chunkCount: 1
      }
    })

    await expect(result).rejects.toThrow(/exceeds client limit/)
    expect(harness.notifications).toContainEqual({
      method: 'git.cancelResponseStream',
      params: { streamId: 7 }
    })
  })

  it('rejects an excessive declared chunk count', async () => {
    const harness = createStreamMux()
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {})
    harness.resolveRequest({
      __orcaGitResponseStream: {
        streamId: 8,
        totalBytes: 1,
        chunkCount: MAX_GIT_RESPONSE_STREAM_CHUNKS + 1
      }
    })

    await expect(result).rejects.toThrow(/exceeds client limit/)
  })

  it('drops an oversized foreign frame received before the stream marker', async () => {
    const harness = createStreamMux()
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {})
    harness.emit('git.responseChunk', {
      streamId: 99,
      seq: 0,
      data: 'A'.repeat(MAX_PRE_METADATA_STREAM_ENCODED_BYTES + 1)
    })
    const payload = Buffer.from('{"ok":true}')
    harness.resolveRequest({
      __orcaGitResponseStream: { streamId: 9, totalBytes: payload.length, chunkCount: 1 }
    })
    await flushRequestResolution()
    harness.emit('git.responseChunk', { streamId: 9, seq: 0, data: payload.toString('base64') })
    harness.emit('git.responseEnd', { streamId: 9 })

    await expect(result).resolves.toEqual({ ok: true })
  })

  it('rejects an encoded chunk larger than the remaining declared bytes', async () => {
    const harness = createStreamMux()
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {})
    harness.resolveRequest({
      __orcaGitResponseStream: { streamId: 10, totalBytes: 1, chunkCount: 1 }
    })
    await flushRequestResolution()
    harness.emit('git.responseChunk', { streamId: 10, seq: 0, data: 'A'.repeat(1_000_000) })

    await expect(result).rejects.toThrow(/exceeds 1 remaining bytes/)
  })

  it('reassembles a valid result without changing its value', async () => {
    const harness = createStreamMux()
    const expected = { answer: 'unchanged', count: 2 }
    const payload = Buffer.from(JSON.stringify(expected))
    const budget = new SshStreamAssemblyBudget(payload.length)
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {}, undefined, budget)
    const first = payload.subarray(0, 7)
    const second = payload.subarray(7)
    harness.resolveRequest({
      __orcaGitResponseStream: { streamId: 11, totalBytes: payload.length, chunkCount: 2 }
    })
    await flushRequestResolution()
    expect(budget.retainedBytes).toBe(payload.length)
    harness.emit('git.responseChunk', { streamId: 11, seq: 0, data: first.toString('base64') })
    harness.emit('git.responseChunk', { streamId: 11, seq: 1, data: second.toString('base64') })
    harness.emit('git.responseEnd', { streamId: 11 })

    await expect(result).resolves.toEqual(expected)
    expect(budget.retainedBytes).toBe(0)
  })

  it('rejects and cancels when the aggregate assembly budget is unavailable', async () => {
    const harness = createStreamMux()
    const budget = new SshStreamAssemblyBudget(1)
    const held = budget.reserve(1)
    const result = requestGitStreamable(harness.mux as never, 'git.diff', {}, undefined, budget)
    harness.resolveRequest({
      __orcaGitResponseStream: { streamId: 16, totalBytes: 1, chunkCount: 1 }
    })

    await expect(result).rejects.toThrow(/Active SSH stream assembly would exceed/)
    expect(harness.notifications).toContainEqual({
      method: 'git.cancelResponseStream',
      params: { streamId: 16 }
    })
    held?.()
  })
})

describe('SSH filesystem stream memory bounds', () => {
  it('releases every active assembly immediately when the shared mux disconnects', async () => {
    const dataHandlers: ((data: Buffer) => void)[] = []
    const transport: MultiplexerTransport = {
      write: vi.fn(),
      onData: (handler) => dataHandlers.push(handler),
      onClose: vi.fn(),
      close: vi.fn()
    }
    const mux = new SshChannelMultiplexer(transport)
    const budget = new SshStreamAssemblyBudget(2)
    const first = readFileViaStream(mux, 'first.txt', undefined, budget)
    const second = readFileViaStream(mux, 'second.txt', undefined, budget)
    const firstRejection = expect(first).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
    const secondRejection = expect(second).rejects.toMatchObject({ code: 'CONNECTION_LOST' })

    dataHandlers[0](
      Buffer.concat([
        encodeMuxResponse(1, { streamId: 21, totalSize: 1, isBinary: false }, 1),
        encodeMuxResponse(2, { streamId: 22, totalSize: 1, isBinary: false }, 2)
      ])
    )
    await flushRequestResolution()
    expect(budget.retainedBytes).toBe(2)

    mux.dispose('connection_lost')

    expect(budget.retainedBytes).toBe(0)
    await firstRejection
    await secondRejection
  })

  it('drops an oversized foreign frame received before file metadata', async () => {
    const harness = createStreamMux()
    const result = readFileViaStream(harness.mux as never, 'tiny.txt')
    harness.emit('fs.streamChunk', {
      streamId: 90,
      seq: 0,
      data: 'A'.repeat(MAX_PRE_METADATA_STREAM_ENCODED_BYTES + 1)
    })
    harness.resolveRequest({
      streamId: 12,
      totalSize: 1,
      isBinary: false,
      resultEncoding: 'utf-8'
    })
    await flushRequestResolution()
    harness.emit('fs.streamChunk', {
      streamId: 12,
      seq: 0,
      data: Buffer.from('a').toString('base64')
    })
    harness.emit('fs.streamEnd', { streamId: 12 })

    await expect(result).resolves.toEqual({ content: 'a', isBinary: false })
  })

  it('validates encoded size before decoding a file chunk', async () => {
    const harness = createStreamMux()
    const result = readFileViaStream(harness.mux as never, 'tiny.txt')
    harness.resolveRequest({ streamId: 13, totalSize: 1, isBinary: false })
    await flushRequestResolution()
    harness.emit('fs.streamChunk', { streamId: 13, seq: 0, data: 'A'.repeat(1_000_000) })

    await expect(result).rejects.toThrow(/Encoded chunk length mismatch/)
    expect(harness.notifications).toContainEqual({
      method: 'fs.cancelStream',
      params: { streamId: 13 }
    })
  })

  it('cancels a file stream that stops making progress', async () => {
    vi.useFakeTimers()
    const harness = createStreamMux()
    const result = readFileViaStream(harness.mux as never, 'stalled.txt', {
      inactivityTimeoutMs: 50
    })
    harness.resolveRequest({ streamId: 14, totalSize: 1, isBinary: false })
    await flushRequestResolution()

    const rejection = expect(result).rejects.toThrow(/stalled/)
    await vi.advanceTimersByTimeAsync(51)
    await rejection
    expect(harness.notifications).toContainEqual({
      method: 'fs.cancelStream',
      params: { streamId: 14 }
    })
  })

  it('resets the inactivity deadline on progress and preserves valid content', async () => {
    vi.useFakeTimers()
    const harness = createStreamMux()
    const first = Buffer.alloc(STREAM_CHUNK_SIZE, 0x61)
    const second = Buffer.from('z')
    const budget = new SshStreamAssemblyBudget(first.length + second.length)
    const result = readFileViaStream(
      harness.mux as never,
      'progress.txt',
      { inactivityTimeoutMs: 50 },
      budget
    )
    harness.resolveRequest({
      streamId: 15,
      totalSize: first.length + second.length,
      isBinary: false,
      resultEncoding: 'utf-8'
    })
    await flushRequestResolution()
    expect(budget.retainedBytes).toBe(first.length + second.length)
    await vi.advanceTimersByTimeAsync(40)
    harness.emit('fs.streamChunk', { streamId: 15, seq: 0, data: first.toString('base64') })
    await vi.advanceTimersByTimeAsync(40)
    harness.emit('fs.streamChunk', { streamId: 15, seq: 1, data: second.toString('base64') })
    harness.emit('fs.streamEnd', { streamId: 15 })

    await expect(result).resolves.toEqual({
      content: `${'a'.repeat(STREAM_CHUNK_SIZE)}z`,
      isBinary: false
    })
    expect(budget.retainedBytes).toBe(0)
  })

  it('rejects and cancels when file assembly would exceed the aggregate budget', async () => {
    const harness = createStreamMux()
    const budget = new SshStreamAssemblyBudget(1)
    const held = budget.reserve(1)
    const result = readFileViaStream(harness.mux as never, 'tiny.txt', undefined, budget)
    harness.resolveRequest({ streamId: 17, totalSize: 1, isBinary: false })

    await expect(result).rejects.toThrow(/Active SSH stream assembly would exceed/)
    expect(harness.notifications).toContainEqual({
      method: 'fs.cancelStream',
      params: { streamId: 17 }
    })
    held?.()
  })
})
