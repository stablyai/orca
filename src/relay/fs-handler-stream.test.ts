import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { MAX_CONCURRENT_STREAMS, STREAM_CHUNK_SIZE } from './protocol'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

type NotificationLane = 'producer' | 'bulk' | 'control'
type Notification = {
  method: string
  params?: Record<string, unknown>
  lane: NotificationLane
  clientId?: number
}
type MockRequestContext = { clientId?: number; isStale: () => boolean }

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: MockRequestContext) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: Notification[] = []
  const droppedProducerFrames: Notification[] = []
  // Mirrors the real lane split: a saturated producer queue drops frames, control frames still land.
  let producerSaturated = false
  let holdControlSettlement = false
  const heldControlSettlements: (() => void)[] = []
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
      const frame: Notification = { method, params, lane: 'producer' }
      if (producerSaturated) {
        droppedProducerFrames.push(frame)
        return
      }
      notifications.push(frame)
    }),
    notifyBulk: vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        opts?: { clientId?: number }
      ): Promise<void> => {
        notifications.push({ method, params, lane: 'bulk', clientId: opts?.clientId })
      }
    ),
    notifyClient: vi.fn((clientId: number, method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params, lane: 'control', clientId })
    }),
    // Mirrors the real control lane: the frame is queued on enqueue, but settles only once the
    // sink actually wrote it — holding settlement models a socket that is not draining.
    tryNotifyClient: vi.fn(
      (
        clientId: number,
        method: string,
        params?: Record<string, unknown>,
        onSettled?: (result: { ok: boolean }) => void
      ): boolean => {
        notifications.push({ method, params, lane: 'control', clientId })
        const settle = () => onSettled?.({ ok: true })
        if (holdControlSettlement) {
          heldControlSettlements.push(settle)
        } else {
          settle()
        }
        return true
      }
    ),
    notifyControl: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params, lane: 'control' })
    }),
    _notifications: notifications,
    _droppedProducerFrames: droppedProducerFrames,
    saturateProducerLane() {
      producerSaturated = true
    },
    holdControlSettlements() {
      holdControlSettlement = true
    },
    settleHeldControlFrames() {
      holdControlSettlement = false
      for (const settle of heldControlSettlements.splice(0)) {
        settle()
      }
    },
    callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: MockRequestContext
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

  it('publishes fs.streamEnd after the final fs.streamChunk and targets the same client', async () => {
    const filePath = path.join(tmpDir, 'targeted.png')
    writeFileSync(filePath, Buffer.alloc(300 * 1024, 0x42))

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { clientId: 7, isStale: () => false }
    )) as { streamId: number }

    await waitFor(() => collectStream(dispatcher).end !== null)
    const frames = dispatcher._notifications
    const endIndex = frames.findIndex((n) => n.method === 'fs.streamEnd')
    const lastChunkIndex = frames.map((n) => n.method).lastIndexOf('fs.streamChunk')
    expect(lastChunkIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBe(lastChunkIndex + 1)
    expect(frames[endIndex]).toEqual({
      method: 'fs.streamEnd',
      params: { streamId: meta.streamId },
      lane: 'control',
      clientId: 7
    })
    expect(frames[lastChunkIndex].clientId).toBe(7)
  })

  // Real saturation is not constructible: the fixed-bulk lane admits a chunk only while producerBytes is 0,
  // so a real backlog parks the chunk pump long before the terminal frame — hence the lane-tagging mock.
  it('orders fs.streamEnd after the final chunk on the control lane and releases the stream', async () => {
    const filePath = path.join(tmpDir, 'stream-end-release.png')
    writeFileSync(filePath, Buffer.alloc(300 * 1024, 0x42))
    // Producer-lane frames now divert to the drop log, so an empty log proves no stream frame took that lane.
    dispatcher.saturateProducerLane()

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { clientId: 3, isStale: () => false }
    )) as { streamId: number }

    await waitFor(() => collectStream(dispatcher).end !== null)
    expect(dispatcher._droppedProducerFrames).toHaveLength(0)
    expect(collectStream(dispatcher).end).toEqual({ streamId: meta.streamId })

    const frames = dispatcher._notifications
    const endIndex = frames.findIndex((n) => n.method === 'fs.streamEnd')
    const lastChunkIndex = frames.map((n) => n.method).lastIndexOf('fs.streamChunk')
    expect(lastChunkIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBe(lastChunkIndex + 1)
    expect(frames[endIndex].lane).toBe('control')

    const registry = (handler as unknown as { streamRegistry: { size(): number } }).streamRegistry
    await waitFor(() => registry.size() === 0)
  })

  it('fills protocol chunks when fs.read returns short before EOF', async () => {
    const filePath = path.join(tmpDir, 'short-read.png')
    const content = Buffer.alloc(STREAM_CHUNK_SIZE + 17, 0x42)
    writeFileSync(filePath, content)

    const sampleHandle = await fs.open(filePath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(sampleHandle) as {
      read: typeof sampleHandle.read
    }
    await sampleHandle.close()

    type PositionedRead = (
      this: typeof sampleHandle,
      buffer: Buffer,
      offset: number | null,
      length: number | null,
      position: number | null
    ) => Promise<{ bytesRead: number; buffer: Buffer }>
    const originalRead = fileHandlePrototype.read as unknown as PositionedRead
    const readSpy = vi.spyOn(fileHandlePrototype, 'read').mockImplementation(async function (
      this: typeof sampleHandle,
      buffer: Buffer,
      offset: number | null = 0,
      length: number | null = buffer.byteLength,
      position: number | null = null
    ) {
      const readLength = position === 0 && length !== null ? Math.min(length, 5) : length
      return originalRead.call(this, buffer, offset, readLength, position)
    } as typeof sampleHandle.read)
    try {
      await dispatcher.callRequest('fs.readFileStream', { filePath }, { isStale: () => false })
      await waitFor(() => collectStream(dispatcher).end !== null)
    } finally {
      readSpy.mockRestore()
    }

    const { chunks, end, err } = collectStream(dispatcher)
    expect(err).toBeNull()
    expect(end).not.toBeNull()
    expect(chunks.map((c) => Buffer.from(c.data, 'base64').length)).toEqual([STREAM_CHUNK_SIZE, 17])
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

  it('parks the pump at the ack credit window and resumes on fs.streamAck', async () => {
    const filePath = path.join(tmpDir, 'paced.png')
    const content = Buffer.alloc(1536 * 1024, 0x42) // 6 chunks
    writeFileSync(filePath, content)

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath, flowControl: 'ack' },
      { isStale: () => false }
    )) as { streamId: number }

    // Window of 4 admits seqs 0..3; seq 4 must wait for an ack.
    await waitFor(() => collectStream(dispatcher).chunks.length === 4)
    await flush(10)
    expect(collectStream(dispatcher).chunks.length).toBe(4)
    expect(collectStream(dispatcher).end).toBeNull()

    // Ack one chunk → exactly one more is admitted.
    dispatcher.callNotification('fs.streamAck', { streamId: meta.streamId, seq: 0 })
    await waitFor(() => collectStream(dispatcher).chunks.length === 5)
    await flush(10)
    expect(collectStream(dispatcher).chunks.length).toBe(5)

    for (let seq = 1; seq < 6; seq += 1) {
      dispatcher.callNotification('fs.streamAck', { streamId: meta.streamId, seq })
    }
    await waitFor(() => collectStream(dispatcher).end !== null)

    const { chunks, err } = collectStream(dispatcher)
    expect(err).toBeNull()
    const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))
    expect(reassembled.equals(content)).toBe(true)
  })

  it('releases a pump parked on the ack window when the stream is cancelled', async () => {
    const filePath = path.join(tmpDir, 'parked-cancel.png')
    writeFileSync(filePath, Buffer.alloc(4 * 1024 * 1024, 0x42)) // 16 chunks

    const meta = (await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath, flowControl: 'ack' },
      { isStale: () => false }
    )) as { streamId: number }

    await waitFor(() => collectStream(dispatcher).chunks.length === 4)
    dispatcher.callNotification('fs.cancelStream', { streamId: meta.streamId })

    const registry = (handler as unknown as { streamRegistry: { size(): number } }).streamRegistry
    await waitFor(() => registry.size() === 0)

    const { end, err } = collectStream(dispatcher)
    expect(end).toBeNull()
    expect(err).toBeNull()
  })

  it('caps undelivered terminal frames so they cannot overflow the link-killing control lane', async () => {
    const filePath = path.join(tmpDir, 'terminal-budget.png')
    writeFileSync(filePath, Buffer.alloc(STREAM_CHUNK_SIZE, 0x42)) // one chunk per stream
    // A socket that accepts nothing: control frames queue, and the real writer destroys the
    // client once 256 of them pile up.
    dispatcher.holdControlSettlements()

    const registry = (handler as unknown as { streamRegistry: { size(): number } }).streamRegistry
    const context = { clientId: 5, isStale: () => false }
    const terminalFrames = () =>
      dispatcher._notifications.filter(
        (n) => n.method === 'fs.streamEnd' || n.method === 'fs.streamError'
      )

    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
      await dispatcher.callRequest('fs.readFileStream', { filePath }, context)
      await waitFor(() => terminalFrames().length === i + 1)
    }
    // The fd must go back even though its terminal frame is still undelivered.
    await waitFor(() => registry.size() === 0)

    await expect(
      dispatcher.callRequest('fs.readFileStream', { filePath }, context)
    ).rejects.toThrow(/Too many concurrent streams/)
    await flush(10)
    expect(terminalFrames()).toHaveLength(MAX_CONCURRENT_STREAMS)

    // The budget is per client, so a second peer on the same relay still reads.
    await dispatcher.callRequest(
      'fs.readFileStream',
      { filePath },
      { clientId: 9, isStale: () => false }
    )
    await waitFor(() => terminalFrames().length === MAX_CONCURRENT_STREAMS + 1)

    // Draining the sink settles the queued frames and hands the budget back.
    dispatcher.settleHeldControlFrames()
    await dispatcher.callRequest('fs.readFileStream', { filePath }, context)
    await waitFor(() => terminalFrames().length === MAX_CONCURRENT_STREAMS + 2)
  })

  it('rejects the 17th concurrent stream with TooManyStreams', async () => {
    const paths: string[] = []
    for (let i = 0; i < 17; i++) {
      const p = path.join(tmpDir, `s${i}.png`)
      writeFileSync(p, Buffer.alloc(8 * 1024 * 1024, 0x42))
      paths.push(p)
    }

    const isStale = () => false
    const queuedPumps: (() => void)[] = []
    // Why: the concurrency cap is about registered active streams. Hold the
    // scheduled pumps so fast CI machines cannot finish early streams before
    // the 17th request checks the registry size.
    const setImmediateSpy = vi
      .spyOn(globalThis, 'setImmediate')
      .mockImplementation((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
        queuedPumps.push(() => callback(...args))
        return {} as NodeJS.Immediate
      })
    try {
      for (let i = 0; i < 16; i++) {
        await dispatcher.callRequest('fs.readFileStream', { filePath: paths[i] }, { isStale })
      }
      await expect(
        dispatcher.callRequest('fs.readFileStream', { filePath: paths[16] }, { isStale })
      ).rejects.toThrow(/Too many concurrent streams/)
    } finally {
      setImmediateSpy.mockRestore()
    }
    for (const runPump of queuedPumps) {
      runPump()
    }
    await flush(50)
  }, 20_000)
})
