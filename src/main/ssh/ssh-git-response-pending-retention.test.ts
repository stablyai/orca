import { expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { requestGitStreamable } from './ssh-git-response-stream-reader'

function fixture() {
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const replies: ((value: unknown) => void)[] = []
  const mux = {
    request: vi.fn(() => new Promise<unknown>((resolve) => replies.push(resolve))),
    notify: vi.fn(),
    isDisposed: () => false,
    onDispose: () => () => {},
    onNotificationByMethod: (
      method: string,
      callback: (params: Record<string, unknown>) => void
    ) => {
      const callbacks = listeners.get(method) ?? new Set()
      callbacks.add(callback)
      listeners.set(method, callbacks)
      return () => callbacks.delete(callback)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the request, disposal and notification surface used by this reader.
  const typedMux = mux as unknown as SshChannelMultiplexer
  return {
    mux: typedMux,
    mock: mux,
    replies,
    emit: (method: string, params: Record<string, unknown>) => {
      for (const callback of listeners.get(method) ?? []) {
        callback(params)
      }
    },
    listenerCount: () => [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0)
  }
}

const marker = (streamId: number, totalBytes: number, chunkCount: number) => ({
  __orcaGitResponseStream: { streamId, totalBytes, chunkCount }
})

it('drops oversized frames before metadata and fails only their identified owner', async () => {
  const f = fixture()
  const own = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const foreign = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const rejected = expect(own).rejects.toThrow('retention budget')
  f.emit('git.responseChunk', { streamId: 1, seq: 0, data: 'x'.repeat(1024 * 1024) })
  f.emit('git.responseChunk', { streamId: 2, seq: 0, data: Buffer.from('[]').toString('base64') })
  f.emit('git.responseEnd', { streamId: 2 })
  f.replies[1](marker(2, 2, 1))
  await expect(foreign).resolves.toEqual([])
  f.replies[0](marker(1, 64, 1))
  await rejected
  expect(f.mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 1 })
  expect(f.listenerCount()).toBe(0)
})

it('refuses chunked pre-metadata overflow even when the discarded data was foreign-shaped', async () => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const rejected = expect(result).rejects.toThrow('retention budget')
  for (let seq = 0; seq < 100; seq++) {
    f.emit('git.responseChunk', { streamId: 1, seq, data: 'x'.repeat(40) })
  }
  f.replies[0](marker(1, 64, 100))
  await rejected
  expect(f.listenerCount()).toBe(0)
})

it('cleans abandoned queues and cancels a sentinel that arrives after abort', async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = requestGitStreamable(
    f.mux,
    'fs.readDir',
    {},
    { signal: controller.signal, maxResponseBytes: 64 }
  )
  const rejected = expect(result).rejects.toThrow('cancelled')
  f.emit('git.responseChunk', { streamId: 1, seq: 0, data: 'e30=' })
  controller.abort()
  await rejected
  expect(f.listenerCount()).toBe(0)
  f.replies[0](marker(1, 2, 1))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 1 })
})

it('preserves honest ordered pre-metadata chunks and ignores malformed foreign params', async () => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  f.emit('git.responseChunk', { streamId: { large: 'x'.repeat(1024) }, data: 'x'.repeat(1024) })
  f.emit('git.responseChunk', { streamId: 1, seq: 0, data: Buffer.from('[1,').toString('base64') })
  f.emit('git.responseChunk', { streamId: 1, seq: 1, data: Buffer.from('2]').toString('base64') })
  f.emit('git.responseEnd', { streamId: 1 })
  f.replies[0](marker(1, 5, 2))
  await expect(result).resolves.toEqual([1, 2])
  expect(f.listenerCount()).toBe(0)
})

it('cleans the pending queue when the metadata request fails', async () => {
  const f = fixture()
  f.mock.request.mockRejectedValueOnce(new Error('metadata unavailable'))
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  f.emit('git.responseChunk', { streamId: 1, seq: 0, data: 'e30=' })
  await expect(result).rejects.toThrow('metadata unavailable')
  expect(f.listenerCount()).toBe(0)
})

it('drops assembled parts and subscriptions on a stalled owned stream', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    const result = requestGitStreamable(
      f.mux,
      'fs.readDir',
      {},
      { maxResponseBytes: 64, inactivityTimeoutMs: 10 }
    )
    const rejected = expect(result).rejects.toThrow('stalled')
    f.replies[0](marker(1, 4, 2))
    await Promise.resolve()
    f.emit('git.responseChunk', { streamId: 1, seq: 0, data: Buffer.from('[').toString('base64') })
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(f.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 1 })
  } finally {
    vi.useRealTimers()
  }
})

it('accepts an exact-budget honest response split across padded base64 chunks', async () => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const payload = JSON.stringify('x'.repeat(62))
  expect(Buffer.byteLength(payload)).toBe(64)
  for (let seq = 0; seq < 4; seq++) {
    f.emit('git.responseChunk', {
      streamId: 1,
      seq,
      data: Buffer.from(payload.slice(seq * 16, (seq + 1) * 16)).toString('base64')
    })
  }
  f.emit('git.responseEnd', { streamId: 1 })
  f.replies[0](marker(1, 64, 4))
  await expect(result).resolves.toBe('x'.repeat(62))
})

it.each(['', '====', '!'])(
  'rejects zero-progress chunks %j without retaining or ACKing them',
  async (data) => {
    const f = fixture()
    const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
    const rejected = expect(result).rejects.toThrow('byte progress')
    f.replies[0](marker(1, 2, 1))
    await Promise.resolve()
    for (let seq = 0; seq < 100_000; seq++) {
      f.emit('git.responseChunk', { streamId: 1, seq, data })
    }
    await rejected
    expect(f.mock.notify).not.toHaveBeenCalledWith('git.responseAck', expect.anything())
    expect(f.mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 1 })
    expect(f.listenerCount()).toBe(0)
  }
)

it.each([
  ['chunks', 2, 1, '['],
  ['bytes', 2, 2, '[]']
])('rejects excess declared %s before ACKing', async (_kind, total, chunks, text) => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const rejected = expect(result).rejects.toThrow('declared')
  f.replies[0](marker(1, Number(total), Number(chunks)))
  await Promise.resolve()
  f.emit('git.responseChunk', {
    streamId: 1,
    seq: 0,
    data: Buffer.from(String(text)).toString('base64')
  })
  f.emit('git.responseChunk', { streamId: 1, seq: 1, data: Buffer.from(']').toString('base64') })
  await rejected
  expect(f.mock.notify.mock.calls.filter(([method]) => method === 'git.responseAck')).toHaveLength(
    1
  )
  expect(f.listenerCount()).toBe(0)
})

it('rejects an enormous declared count independently of continued empty frames', async () => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const rejected = expect(result).rejects.toThrow('chunk count')
  f.replies[0](marker(1, 2, Number.MAX_SAFE_INTEGER))
  await rejected
  expect(f.listenerCount()).toBe(0)
})

it.each([true, false])(
  'bounds owned error diagnostics with metadata first: %s',
  async (metadataFirst) => {
    const f = fixture()
    const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
    const rejected = expect(result).rejects.toThrow('retention budget')
    if (metadataFirst) {
      f.replies[0](marker(1, 2, 1))
      await Promise.resolve()
    }
    f.emit('git.responseError', { streamId: 1, message: 'x'.repeat(1024 * 1024) })
    if (!metadataFirst) {
      f.replies[0](marker(1, 2, 1))
    }
    await rejected
    expect(f.listenerCount()).toBe(0)
  }
)

it('preserves short upstream error text', async () => {
  const f = fixture()
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: 64 })
  const rejected = expect(result).rejects.toThrow('permission denied')
  f.replies[0](marker(1, 2, 1))
  await Promise.resolve()
  f.emit('git.responseError', { streamId: 1, message: 'permission denied' })
  await rejected
})

it('reassembles one-byte valid chunks without a per-chunk retained buffer', async () => {
  const f = fixture()
  const text = JSON.stringify('x'.repeat(100_000))
  const result = requestGitStreamable(f.mux, 'fs.readDir', {}, { maxResponseBytes: text.length })
  f.replies[0](marker(1, text.length, text.length))
  await Promise.resolve()
  for (let seq = 0; seq < text.length; seq++) {
    f.emit('git.responseChunk', {
      streamId: 1,
      seq,
      data: Buffer.from(text[seq]).toString('base64')
    })
  }
  f.emit('git.responseEnd', { streamId: 1 })
  await expect(result).resolves.toBe('x'.repeat(100_000))
  expect(f.listenerCount()).toBe(0)
})
