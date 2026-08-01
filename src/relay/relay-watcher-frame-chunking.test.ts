import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher, type RelayClientSinkOptions } from './dispatcher'
import { HEADER_LENGTH, encodeJsonRpcFrame, parseJsonRpcMessage } from './protocol'
import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process'
import { emitRelayWatcherEvents } from './relay-watcher-event-emitter'

// Node >=22 defaults the socket highWaterMark to 64 KiB, Node <=21 to 16 KiB.
const NODE_22_HIGH_WATER_MARK = 64 * 1024
const NODE_22_PRODUCER_CAPACITY = 49_152
const NODE_21_HIGH_WATER_MARK = 16 * 1024
const NODE_21_PRODUCER_CAPACITY = 12_288

type WatcherEventPayload = {
  kind: string
  absolutePath: string
  isDirectory?: boolean
}

type ClientCapture = {
  frames: Buffer[]
  framedEvents: () => WatcherEventPayload[][]
  fsChangedEvents: () => WatcherEventPayload[]
}

function captureFrames(): { capture: ClientCapture; write: (frame: Buffer) => boolean } {
  const frames: Buffer[] = []
  const decode = (frame: Buffer): { method: string; events: WatcherEventPayload[] } => {
    const payloadLength = frame.readUInt32BE(9)
    const message = parseJsonRpcMessage(
      frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength)
    ) as { method?: string; params?: { events?: WatcherEventPayload[] } }
    return { method: message.method ?? '', events: message.params?.events ?? [] }
  }
  const framedEvents = (): WatcherEventPayload[][] =>
    frames
      .map((frame) => decode(frame))
      .filter((decoded) => decoded.method === 'fs.changed')
      .map((decoded) => decoded.events)
  return {
    capture: {
      frames,
      framedEvents,
      fsChangedEvents: () => framedEvents().flat()
    },
    write: (frame) => {
      frames.push(Buffer.from(frame))
      return true
    }
  }
}

function createDispatcher(
  highWaterMark: number,
  sinkOptions: RelayClientSinkOptions = {}
): {
  dispatcher: RelayDispatcher
  capture: ClientCapture
  detached: number[]
} {
  const { capture, write } = captureFrames()
  const detached: number[] = []
  const dispatcher = new RelayDispatcher(write, {
    writableHighWaterMark: () => highWaterMark,
    writableLength: () => 0,
    ...sinkOptions
  })
  dispatcher.onClientDetached((clientId) => detached.push(clientId))
  return { dispatcher, capture, detached }
}

function watcherBatch(count: number): WatcherProcessEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 3 === 0 ? 'create' : index % 3 === 1 ? 'update' : 'delete',
    path: `/Users/dev/workspaces/orca/node_modules/.pnpm/@scope+package@1.2.3/dist/chunk-${String(index).padStart(6, '0')}.js`,
    isDirectory: false
  })) as WatcherProcessEvent[]
}

// Each path encodes beyond its UTF-16 length, exposing character-based budgets.
function multiByteWatcherBatch(count: number): WatcherProcessEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 3 === 0 ? 'create' : index % 3 === 1 ? 'update' : 'delete',
    path: `/Users/dev/プロジェクト/日本語のディレクトリ/файлы/🚀-переклад/"quoted"\\escaped\\chunk-${String(index).padStart(6, '0')}.js`,
    isDirectory: false
  })) as WatcherProcessEvent[]
}

function frameBytesFor(events: readonly WatcherEventPayload[]): number {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', method: 'fs.changed', params: { events } }, 0, 0)
    .length
}

// Real encodes keep this boundary oracle independent from the emitter's arithmetic.
function batchEncodingTo(targetBytes: number): WatcherProcessEvent[] {
  const events = watcherBatch(400)
  let fitting = 1
  while (
    fitting < events.length &&
    frameBytesFor(expectedPayloads(events.slice(0, fitting + 1))) <= targetBytes
  ) {
    fitting++
  }
  const batch = events.slice(0, fitting)
  const last = batch[fitting - 1]
  const padding = targetBytes - frameBytesFor(expectedPayloads(batch))
  batch[fitting - 1] = { ...last, path: `${last.path}${'a'.repeat(padding)}` }
  return batch
}

function expectedPayloads(events: readonly WatcherProcessEvent[]): WatcherEventPayload[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
  }))
}

// Moving the next event forward must exceed capacity, catching needless splits.
function expectMaximallyPackedChunks(capture: ClientCapture, capacity: number): void {
  const chunks = capture.framedEvents()
  expect(chunks.length).toBeGreaterThan(1)
  for (let index = 0; index + 1 < chunks.length; index++) {
    expect(frameBytesFor([...chunks[index], chunks[index + 1][0]])).toBeGreaterThan(capacity)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relay watcher fs.changed frame chunking', () => {
  it('delivers a 5000-event batch to a Node<=21 client without closing it', () => {
    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    const events = watcherBatch(5000)

    try {
      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([])
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
      expectMaximallyPackedChunks(capture, NODE_21_PRODUCER_CAPACITY)
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(events))
    } finally {
      dispatcher.dispose()
    }
  })

  it('delivers a 5000-event batch to a Node>=22 client without closing it', () => {
    const { dispatcher, capture, detached } = createDispatcher(NODE_22_HIGH_WATER_MARK)
    const events = watcherBatch(5000)

    try {
      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([])
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_22_PRODUCER_CAPACITY)
      }
      expectMaximallyPackedChunks(capture, NODE_22_PRODUCER_CAPACITY)
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(events))
    } finally {
      dispatcher.dispose()
    }
  })

  it('sizes chunks in encoded bytes for multi-byte and JSON-escaped paths', () => {
    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    const events = multiByteWatcherBatch(5000)

    try {
      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([])
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
      expectMaximallyPackedChunks(capture, NODE_21_PRODUCER_CAPACITY)
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(events))
    } finally {
      dispatcher.dispose()
    }
  })

  it('fills the first chunk to exactly the producer capacity and admits it', () => {
    const exact = batchEncodingTo(NODE_21_PRODUCER_CAPACITY)
    expect(frameBytesFor(expectedPayloads(exact))).toBe(NODE_21_PRODUCER_CAPACITY)
    const events = [...exact, ...watcherBatch(50)]

    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    try {
      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([])
      expect(capture.frames).toHaveLength(2)
      expect(capture.frames[0].length).toBe(NODE_21_PRODUCER_CAPACITY)
      expect(capture.framedEvents()[0]).toEqual(expectedPayloads(exact))
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(events))
    } finally {
      dispatcher.dispose()
    }
  })

  it('splits one byte past the producer capacity into two admitted frames', () => {
    const overshoot = batchEncodingTo(NODE_21_PRODUCER_CAPACITY + 1)
    expect(frameBytesFor(expectedPayloads(overshoot))).toBe(NODE_21_PRODUCER_CAPACITY + 1)

    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    try {
      emitRelayWatcherEvents(dispatcher, false, overshoot)

      expect(detached).toEqual([])
      expect(capture.frames).toHaveLength(2)
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(overshoot))
    } finally {
      dispatcher.dispose()
    }
  })

  it('sizes chunks against the smallest capacity across attached clients', () => {
    const { capture: attachedCapture, write: attachedWrite } = captureFrames()
    const { dispatcher, capture, detached } = createDispatcher(NODE_22_HIGH_WATER_MARK)
    const events = watcherBatch(2000)

    try {
      dispatcher.attachClient(attachedWrite, {
        writableHighWaterMark: () => NODE_21_HIGH_WATER_MARK,
        writableLength: () => 0
      })

      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([])
      for (const frame of [...capture.frames, ...attachedCapture.frames]) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
      expect(capture.fsChangedEvents()).toEqual(expectedPayloads(events))
      expect(attachedCapture.fsChangedEvents()).toEqual(expectedPayloads(events))
    } finally {
      dispatcher.dispose()
    }
  })

  it('still closes the client when a single event cannot fit any frame', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    const oversized: WatcherProcessEvent[] = [
      { type: 'update', path: `/workspace/${'p'.repeat(20_000)}.txt`, isDirectory: false }
    ]

    try {
      emitRelayWatcherEvents(dispatcher, false, oversized)

      expect(detached).toEqual([1])
      expect(capture.frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })

  it('delivers the prefix then closes when an oversized event appears mid-batch', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK)
    const oversized = {
      type: 'update',
      path: `/workspace/${'p'.repeat(20_000)}.txt`,
      isDirectory: false
    } as WatcherProcessEvent
    const events = [...watcherBatch(300), oversized, ...watcherBatch(50)]

    try {
      emitRelayWatcherEvents(dispatcher, false, events)

      expect(detached).toEqual([1])
      const delivered = capture.fsChangedEvents()
      expect(delivered.length).toBeGreaterThan(0)
      expect(delivered).toEqual(expectedPayloads(events).slice(0, delivered.length))
      expect(delivered.some((event) => event.absolutePath === oversized.path)).toBe(false)
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps the fail-closed kill when retained chunks exhaust the producer queue budget', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    // An unsettled sink models retained relay stdout writes.
    const { dispatcher, capture, detached } = createDispatcher(NODE_21_HIGH_WATER_MARK, {
      supportsWriteCallback: true
    })
    const emitted: WatcherProcessEvent[] = []

    try {
      for (let round = 0; round < 10 && detached.length === 0; round++) {
        const events = watcherBatch(5000)
        emitted.push(...events)
        emitRelayWatcherEvents(dispatcher, false, events)
      }

      expect(detached).toEqual([1])
      const delivered = capture.fsChangedEvents()
      expect(delivered.length).toBeGreaterThan(0)
      expect(delivered.length).toBeLessThan(emitted.length)
      // The kill truncates delivery at a chunk boundary; nothing is reordered or duplicated.
      expect(delivered).toEqual(expectedPayloads(emitted).slice(0, delivered.length))
      for (const frame of capture.frames) {
        expect(frame.length).toBeLessThanOrEqual(NODE_21_PRODUCER_CAPACITY)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not notify at all when no client is attached', () => {
    const { capture, write } = captureFrames()
    const dispatcher = new RelayDispatcher(write, {
      writableHighWaterMark: () => NODE_21_HIGH_WATER_MARK,
      writableLength: () => 0
    })
    const notify = vi.spyOn(dispatcher, 'notify')
    try {
      dispatcher.invalidateClient()
      emitRelayWatcherEvents(dispatcher, false, watcherBatch(10))

      expect(notify).not.toHaveBeenCalled()
      expect(capture.frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })
})
