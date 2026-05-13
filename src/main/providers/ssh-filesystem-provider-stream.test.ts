import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
  _emitMethod: (method: string, params: Record<string, unknown>) => void
}

function createMockMux(): MockMultiplexer {
  const methodHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()
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
    onDispose: vi.fn(() => () => {}),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    _emitMethod: (method, params) => {
      const set = methodHandlers.get(method)
      if (set) {
        for (const handler of Array.from(set)) {
          handler(params)
        }
      }
    }
  }
}

describe('SshFilesystemProvider readFile streaming', () => {
  let mux: MockMultiplexer
  let provider: SshFilesystemProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshFilesystemProvider('conn-1', mux as never)
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
      filePath: '/home/user/file.txt'
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
})
