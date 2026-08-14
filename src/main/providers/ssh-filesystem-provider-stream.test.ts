import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS } from '../ssh/ssh-file-stream-inactivity-deadline'
import { publishSystemResume, publishSystemSuspend } from '../system-power-lifecycle'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
  _emitMethod: (method: string, params: Record<string, unknown>) => void
  _listenerCount: () => number
}

function createMockMux(): MockMultiplexer {
  const methodHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const disposeHandlers = new Set<(reason: 'shutdown' | 'connection_lost') => void>()
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        let set = methodHandlers.get(method)
        if (!set) {
          set = new Set()
          methodHandlers.set(method, set)
        }
        set.add(handler)
        return () => set!.delete(handler)
      }
    ),
    onDispose: vi.fn((handler: (reason: 'shutdown' | 'connection_lost') => void) => {
      disposeHandlers.add(handler)
      return () => {
        disposeHandlers.delete(handler)
      }
    }),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    _emitMethod: (method, params) => {
      const set = methodHandlers.get(method)
      if (set) {
        for (const handler of Array.from(set)) {
          handler(params)
        }
      }
    },
    _listenerCount: () =>
      disposeHandlers.size +
      [...methodHandlers.values()].reduce((count, handlers) => count + handlers.size, 0)
  }
}

describe('SshFilesystemProvider readFile streaming', () => {
  let mux: MockMultiplexer
  let provider: SshFilesystemProvider

  beforeEach(() => {
    publishSystemResume()
    mux = createMockMux()
    provider = new SshFilesystemProvider('conn-1', mux as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams via fs.readFileStream and reassembles utf-8 text', async () => {
    const text = 'hello world'
    const totalSize = Buffer.byteLength(text, 'utf-8')
    mux.request.mockImplementation(async (method: string) => {
      if (method !== 'fs.readFileStream') {
        throw new Error(`unexpected method ${method}`)
      }
      // Why: setImmediate fires after the metadata-resolution .then has set
      // streamIdRef, ensuring subscribed handlers see a matching streamId.
      setImmediate(() => {
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 0,
          data: Buffer.from(text, 'utf-8').toString('base64')
        })
        mux._emitMethod('fs.streamEnd', { streamId: 1 })
      })
      return {
        streamId: 1,
        totalSize,
        isBinary: false,
        chunkEncoding: 'base64',
        resultEncoding: 'utf-8'
      }
    })

    const result = await provider.readFile('/home/user/file.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.readFileStream', {
      filePath: '/home/user/file.txt',
      flowControl: 'ack'
    })
    expect(result).toEqual({ content: text, isBinary: false })
  })

  it('falls back to legacy fs.readFile on -32601 method-not-found', async () => {
    const legacyResult = { content: 'legacy', isBinary: false }
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'fs.readFileStream') {
        const err = new Error('Method not found') as Error & { code: number }
        err.code = -32601
        throw err
      }
      if (method === 'fs.readFile') {
        return legacyResult
      }
      throw new Error(`unexpected method ${method}`)
    })

    const result = await provider.readFile('/home/user/file.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.readFile', { filePath: '/home/user/file.txt' })
    expect(result).toEqual(legacyResult)
  })

  it('rejects when chunk arrives out of order', async () => {
    const totalSize = 256 * 1024 * 2
    mux.request.mockImplementation(async () => {
      setImmediate(() => {
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 1,
          data: Buffer.alloc(256 * 1024).toString('base64')
        })
      })
      return {
        streamId: 1,
        totalSize,
        isBinary: true,
        chunkEncoding: 'base64',
        resultEncoding: 'base64'
      }
    })
    await expect(provider.readFile('/home/x.bin')).rejects.toThrow(/out-of-order/i)
  })

  it('rejects when totalSize exceeds client cap without allocating', async () => {
    mux.request.mockResolvedValue({
      streamId: 1,
      totalSize: 51 * 1024 * 1024,
      isBinary: true,
      chunkEncoding: 'base64',
      resultEncoding: 'base64'
    })
    await expect(provider.readFile('/home/x.bin')).rejects.toThrow(/exceeds client cap/i)
    expect(mux.notify).toHaveBeenCalledWith('fs.cancelStream', { streamId: 1 })
  })

  it('applies a caller binary cap before allocating the stream buffer', async () => {
    mux.request.mockResolvedValue({
      streamId: 2,
      totalSize: 2,
      isBinary: true,
      chunkEncoding: 'base64',
      resultEncoding: 'base64'
    })

    await expect(provider.readFile('/home/x.bin', { maxBinaryBytes: 1 })).rejects.toThrow(
      /exceeds client cap/i
    )
    expect(mux.notify).toHaveBeenCalledWith('fs.cancelStream', { streamId: 2 })
  })

  it('rejects on fs.streamError notification', async () => {
    const totalSize = 1024
    mux.request.mockImplementation(async () => {
      setImmediate(() => {
        mux._emitMethod('fs.streamError', {
          streamId: 7,
          code: 'ENOENT',
          message: 'gone'
        })
      })
      return {
        streamId: 7,
        totalSize,
        isBinary: false,
        chunkEncoding: 'base64',
        resultEncoding: 'utf-8'
      }
    })
    await expect(provider.readFile('/home/x.txt')).rejects.toThrow(/gone/)
  })

  it('cancels and cleans up a stream that stalls after metadata', async () => {
    vi.useFakeTimers()
    mux.request.mockResolvedValue({
      streamId: 9,
      totalSize: 1,
      isBinary: false,
      resultEncoding: 'utf-8'
    })

    const read = provider.readFile('/home/x.txt')
    const rejection = expect(read).rejects.toThrow(/file stream stalled/i)
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS)

    await rejection
    expect(mux.notify).toHaveBeenCalledWith('fs.cancelStream', { streamId: 9 })
    expect(mux._listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a long stream alive while chunks continue arriving', async () => {
    vi.useFakeTimers()
    const chunkSize = 256 * 1024
    mux.request.mockResolvedValue({
      streamId: 10,
      totalSize: chunkSize + 1,
      isBinary: true,
      resultEncoding: 'base64'
    })

    const read = provider.readFile('/home/x.bin')
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS - 1)
    mux._emitMethod('fs.streamChunk', {
      streamId: 10,
      seq: 0,
      data: Buffer.alloc(chunkSize).toString('base64')
    })
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS - 1)
    mux._emitMethod('fs.streamChunk', {
      streamId: 10,
      seq: 1,
      data: Buffer.alloc(1).toString('base64')
    })
    mux._emitMethod('fs.streamEnd', { streamId: 10 })

    await expect(read).resolves.toEqual({
      content: Buffer.alloc(chunkSize + 1).toString('base64'),
      isBinary: true
    })
    expect(mux.notify).not.toHaveBeenCalledWith('fs.cancelStream', expect.anything())
    expect(mux._listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('grants an active stream a fresh inactivity window after system resume', async () => {
    vi.useFakeTimers()
    mux.request.mockResolvedValue({
      streamId: 11,
      totalSize: 1,
      isBinary: false,
      resultEncoding: 'utf-8'
    })

    const read = provider.readFile('/home/x.txt')
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS - 1)
    publishSystemSuspend()
    vi.setSystemTime(Date.now() + 60 * 60_000)
    publishSystemResume()
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS - 1)

    expect(mux.notify).not.toHaveBeenCalledWith('fs.cancelStream', expect.anything())
    mux._emitMethod('fs.streamChunk', {
      streamId: 11,
      seq: 0,
      data: Buffer.from('x').toString('base64')
    })
    mux._emitMethod('fs.streamEnd', { streamId: 11 })
    await expect(read).resolves.toEqual({ content: 'x', isBinary: false })

    publishSystemResume()
    expect(mux._listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps metadata received during suspend paused until resume', async () => {
    vi.useFakeTimers()
    mux.request.mockResolvedValue({
      streamId: 12,
      totalSize: 1,
      isBinary: false,
      resultEncoding: 'utf-8'
    })

    publishSystemSuspend()
    const read = provider.readFile('/home/x.txt')
    const outcome = vi.fn()
    void read.then(
      () => outcome('resolved'),
      () => outcome('rejected')
    )
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(outcome).not.toHaveBeenCalled()
    expect(mux.notify).not.toHaveBeenCalledWith('fs.cancelStream', expect.anything())
    publishSystemResume()
    await vi.advanceTimersByTimeAsync(SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS - 1)
    mux._emitMethod('fs.streamChunk', {
      streamId: 12,
      seq: 0,
      data: Buffer.from('x').toString('base64')
    })
    mux._emitMethod('fs.streamEnd', { streamId: 12 })

    await expect(read).resolves.toEqual({ content: 'x', isBinary: false })
    expect(mux._listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects on chunk count mismatch at streamEnd', async () => {
    const totalSize = 256 * 1024 * 3
    mux.request.mockImplementation(async () => {
      setImmediate(() => {
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 0,
          data: Buffer.alloc(256 * 1024).toString('base64')
        })
        mux._emitMethod('fs.streamEnd', { streamId: 1 })
      })
      return {
        streamId: 1,
        totalSize,
        isBinary: true,
        chunkEncoding: 'base64',
        resultEncoding: 'base64'
      }
    })
    await expect(provider.readFile('/home/x.bin')).rejects.toThrow(/count mismatch/i)
  })

  it('rejects a short final chunk instead of zero-filling the buffer', async () => {
    // Two declared chunks, but the final one delivers a single byte. The chunk
    // count matches (2), so the old code resolved with a zero-filled tail. The
    // exact-length check must reject this.
    const totalSize = 256 * 1024 * 2
    mux.request.mockImplementation(async () => {
      setImmediate(() => {
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 0,
          data: Buffer.alloc(256 * 1024).toString('base64')
        })
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 1,
          data: Buffer.alloc(1).toString('base64')
        })
        mux._emitMethod('fs.streamEnd', { streamId: 1 })
      })
      return {
        streamId: 1,
        totalSize,
        isBinary: true,
        chunkEncoding: 'base64',
        resultEncoding: 'base64'
      }
    })
    await expect(provider.readFile('/home/x.bin')).rejects.toThrow(/length mismatch/i)
  })

  it('rejects a short non-final chunk before later chunks arrive', async () => {
    const totalSize = 256 * 1024 * 2
    mux.request.mockImplementation(async () => {
      setImmediate(() => {
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 0,
          data: Buffer.alloc(1).toString('base64')
        })
        mux._emitMethod('fs.streamChunk', {
          streamId: 1,
          seq: 1,
          data: Buffer.alloc(256 * 1024).toString('base64')
        })
        mux._emitMethod('fs.streamEnd', { streamId: 1 })
      })
      return {
        streamId: 1,
        totalSize,
        isBinary: true,
        chunkEncoding: 'base64',
        resultEncoding: 'base64'
      }
    })
    await expect(provider.readFile('/home/x.bin')).rejects.toThrow(/length mismatch/i)
  })
})
