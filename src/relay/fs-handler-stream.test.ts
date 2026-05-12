import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

type Notification = { method: string; params?: Record<string, unknown> }

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: { isStale: () => boolean }) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: Notification[] = []
  return {
    onRequest: vi.fn(
      (
        method: string,
        handler: typeof requestHandlers extends Map<string, infer H> ? H : never
      ) => {
        requestHandlers.set(method, handler as never)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    _notifications: notifications,
    callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: { isStale: () => boolean }
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, context)
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params)
    }
  }
}

type StreamOutcome = {
  chunks: { seq: number; data: string }[]
  end: { streamId: number } | null
  err: { code: string; message: string } | null
}

function collectStream(d: ReturnType<typeof createMockDispatcher>): StreamOutcome {
  const chunks: { seq: number; data: string }[] = []
  let end: { streamId: number } | null = null
  let err: { code: string; message: string } | null = null
  for (const n of d._notifications) {
    if (n.method === 'fs.streamChunk') {
      chunks.push({ seq: n.params!.seq as number, data: n.params!.data as string })
    } else if (n.method === 'fs.streamEnd') {
      end = { streamId: n.params!.streamId as number }
    } else if (n.method === 'fs.streamError') {
      err = {
        code: n.params!.code as string,
        message: n.params!.message as string
      }
    }
  }
  return { chunks, end, err }
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: predicate did not become true in time')
    }
    await new Promise((r) => setImmediate(r))
  }
}

describe('FsHandler readFileStream', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: FsHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-stream-'))
    dispatcher = createMockDispatcher()
    handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  afterEach(async () => {
    handler.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('streams a binary file in chunked notifications', async () => {
    const filePath = path.join(tmpDir, 'image.png')
    const content = Buffer.alloc(300 * 1024, 0x42)
    writeFileSync(filePath, content)

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => false }
    )) as { streamId: number; totalSize: number; resultEncoding: string }
    expect(meta.streamId).toBeDefined()
    expect(meta.totalSize).toBe(content.length)
    expect(meta.resultEncoding).toBe('base64')

    await waitFor(() => collectStream(dispatcher).end !== null)
    const { chunks, end, err } = collectStream(dispatcher)
    expect(err).toBeNull()
    expect(end).toEqual({ streamId: meta.streamId })
    const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))
    expect(reassembled.equals(content)).toBe(true)
  })

  it('returns empty:true for 0-byte files without opening a handle', async () => {
    const filePath = path.join(tmpDir, 'empty.txt')
    writeFileSync(filePath, '')

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => false }
    )) as { totalSize: number; empty: boolean; streamId?: number }
    expect(meta.empty).toBe(true)
    expect(meta.totalSize).toBe(0)
    expect(meta.streamId).toBeUndefined()

    await flush()
    const { chunks } = collectStream(dispatcher)
    expect(chunks).toHaveLength(0)
  })

  it('returns empty:true for binary archives over the probe threshold', async () => {
    const filePath = path.join(tmpDir, 'archive.bin')
    const content = Buffer.alloc(20 * 1024, 0x61)
    content[0] = 0x00
    writeFileSync(filePath, content)

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => false }
    )) as { totalSize: number; empty: boolean; isBinary: boolean }
    expect(meta.empty).toBe(true)
    expect(meta.isBinary).toBe(true)
  })

  it('returns empty:true for small binary files under the probe threshold', async () => {
    const filePath = path.join(tmpDir, 'small.bin')
    const content = Buffer.from([0x41, 0x00, 0x42])
    writeFileSync(filePath, content)

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => false }
    )) as { totalSize: number; empty: boolean; isBinary: boolean; streamId?: number }
    expect(meta.empty).toBe(true)
    expect(meta.isBinary).toBe(true)
    expect(meta.totalSize).toBe(0)
    expect(meta.streamId).toBeUndefined()
  })

  it('rejects when totalSize exceeds the binary cap', async () => {
    const filePath = path.join(tmpDir, 'huge.png')
    writeFileSync(filePath, Buffer.alloc(51 * 1024 * 1024))

    await expect(
      dispatcher.callRequest('fs.readFileStream', { filePath }, { isStale: () => false })
    ).rejects.toThrow(/File too large/)
  })

  it('exits the pump and emits no further chunks when isStale flips', async () => {
    const filePath = path.join(tmpDir, 'big.png')
    const content = Buffer.alloc(800 * 1024, 0x42)
    writeFileSync(filePath, content)

    let stale = false
    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => stale }
    )) as { streamId: number }

    await new Promise((r) => setImmediate(r))
    stale = true
    await flush(10)

    const { end, err } = collectStream(dispatcher)
    expect(end).toBeNull()
    expect(err).toBeNull()
    expect(meta.streamId).toBeGreaterThan(0)
  })

  it('honors fs.cancelStream by stopping the pump and emitting no end frame', async () => {
    const filePath = path.join(tmpDir, 'cancel.png')
    writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 0x42))

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { isStale: () => false }
    )) as { streamId: number }

    await new Promise((r) => setImmediate(r))
    dispatcher.callNotification('fs.cancelStream', { streamId: meta.streamId })
    await flush(10)

    const { end, err } = collectStream(dispatcher)
    expect(end).toBeNull()
    expect(err).toBeNull()
  })

  it('rejects the 17th concurrent stream with TooManyStreams', async () => {
    const paths: string[] = []
    for (let i = 0; i < 17; i++) {
      const p = path.join(tmpDir, `s${i}.png`)
      writeFileSync(p, Buffer.alloc(8 * 1024 * 1024, 0x42))
      paths.push(p)
    }

    const isStale = () => false
    for (let i = 0; i < 16; i++) {
      await dispatcher.callRequest('fs.readFileStream', { filePath: paths[i] }, { isStale })
    }
    await expect(
      dispatcher.callRequest('fs.readFileStream', { filePath: paths[16] }, { isStale })
    ).rejects.toThrow(/Too many concurrent streams/)
    await flush(50)
  }, 20_000)
})
