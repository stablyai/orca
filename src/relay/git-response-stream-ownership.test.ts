import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  GitResponseStreamRegistry,
  MAX_CONCURRENT_GIT_RESPONSE_STREAMS
} from './git-response-stream'
import { GIT_RESPONSE_CHUNK_SIZE, STREAM_ACK_WINDOW_CHUNKS } from './protocol'

async function flushPump(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('GitResponseStreamRegistry client ownership', () => {
  const registries: GitResponseStreamRegistry[] = []

  afterEach(() => {
    for (const registry of registries) {
      registry.disposeAll()
    }
    registries.length = 0
  })

  it('ignores acknowledgements and cancellation from a different relay client', async () => {
    const ownerClientId = 7
    const notifyBulk = vi.fn().mockResolvedValue(undefined)
    const dispatcher = {
      notifyBulk,
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const context: RequestContext = {
      clientId: ownerClientId,
      isStale: () => false
    }
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)
    const payload = Buffer.alloc(GIT_RESPONSE_CHUNK_SIZE * (STREAM_ACK_WINDOW_CHUNKS * 3))
    const marker = registry.startStream(payload, dispatcher, context)
    const streamId = marker.__orcaGitResponseStream.streamId

    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    registry.recordAck(streamId, 10_000, ownerClientId)
    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    registry.recordAck(streamId, 10_000, ownerClientId + 1)
    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    for (const invalidSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      registry.recordAck(streamId, invalidSeq, ownerClientId)
    }
    await flushPump()
    expect(notifyBulk).toHaveBeenCalledTimes(STREAM_ACK_WINDOW_CHUNKS)

    registry.abort(streamId, ownerClientId + 1)
    registry.recordAck(streamId, STREAM_ACK_WINDOW_CHUNKS - 1, ownerClientId)
    await flushPump()
    expect(notifyBulk.mock.calls.length).toBeGreaterThan(STREAM_ACK_WINDOW_CHUNKS)
  })

  it('contains a secondary failure while reporting a stream error', async () => {
    const notifyBulk = vi.fn().mockRejectedValue(new Error('socket closed'))
    const dispatcher = { notifyBulk, notify: vi.fn() } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)

    registry.startStream(Buffer.from('payload'), dispatcher, {
      clientId: 7,
      isStale: () => false
    })

    await flushPump()
    await flushPump()

    expect(notifyBulk).toHaveBeenCalledTimes(2)
    expect(notifyBulk.mock.calls[0]?.[0]).toBe('git.responseChunk')
    expect(notifyBulk.mock.calls[1]?.[0]).toBe('git.responseError')
  })

  it('caps parked streams and defers base64 expansion until the pump runs', () => {
    const dispatcher = {
      notifyBulk: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)
    const payload = Buffer.from('payload')
    const toStringSpy = vi.spyOn(Buffer.prototype, 'toString')

    try {
      for (let index = 0; index < MAX_CONCURRENT_GIT_RESPONSE_STREAMS; index += 1) {
        registry.startStream(payload, dispatcher, {
          clientId: 7,
          isStale: () => false
        })
      }

      expect(toStringSpy.mock.calls.some(([encoding]) => encoding === 'base64')).toBe(false)
      expect(() =>
        registry.startStream(payload, dispatcher, {
          clientId: 7,
          isStale: () => false
        })
      ).toThrow(`Too many concurrent git response streams`)
    } finally {
      toStringSpy.mockRestore()
    }
  })

  it('caps aggregate bytes retained by concurrent parked responses', () => {
    const dispatcher = {
      notifyBulk: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry(10)
    registries.push(registry)
    const context = { clientId: 7, isStale: () => false }

    registry.startStream(Buffer.alloc(6), dispatcher, context)
    registry.startStream(Buffer.alloc(4), dispatcher, context)

    expect(() => registry.startStream(Buffer.alloc(1), dispatcher, context)).toThrow(
      'Concurrent git responses exceed retained-byte limit (10 bytes)'
    )
  })

  it('rejects a serialized string before allocating any encoded chunk', () => {
    const dispatcher = {
      notifyBulk: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry(0)
    registries.push(registry)
    const fromSpy = vi.spyOn(Buffer, 'from')

    try {
      expect(() =>
        registry.startStream('serialized response', dispatcher, {
          clientId: 7,
          isStale: () => false
        })
      ).toThrow('Concurrent git responses exceed retained-byte limit (0 bytes)')
      expect(fromSpy).not.toHaveBeenCalled()
    } finally {
      fromSpy.mockRestore()
    }
  })

  it('streams a serialized string without changing its UTF-8 bytes', async () => {
    const chunks: Buffer[] = []
    const notifyBulk = vi.fn().mockImplementation((method, params) => {
      if (method === 'git.responseChunk') {
        chunks.push(Buffer.from(params.data, 'base64'))
      }
      return Promise.resolve()
    })
    const dispatcher = { notifyBulk, notify: vi.fn() } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry()
    registries.push(registry)
    const serialized = JSON.stringify({ text: `boundary-${'🐋'.repeat(40_000)}` })

    const marker = registry.startStream(serialized, dispatcher, {
      clientId: 7,
      isStale: () => false
    })
    await flushPump()
    await flushPump()

    expect(Buffer.concat(chunks)).toEqual(Buffer.from(serialized, 'utf8'))
    expect(chunks).toHaveLength(marker.__orcaGitResponseStream.chunkCount)
    expect(marker.__orcaGitResponseStream.totalBytes).toBe(Buffer.byteLength(serialized, 'utf8'))
  })

  it('releases aggregate bytes after completion and disposal', async () => {
    const dispatcher = {
      notifyBulk: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    } as unknown as RelayDispatcher
    const registry = new GitResponseStreamRegistry(10)
    registries.push(registry)
    const context = { clientId: 7, isStale: () => false }

    registry.startStream(Buffer.alloc(10), dispatcher, context)
    await flushPump()
    expect(() => registry.startStream(Buffer.alloc(10), dispatcher, context)).not.toThrow()

    registry.disposeAll()
    expect(() => registry.startStream(Buffer.alloc(10), dispatcher, context)).not.toThrow()
  })
})
