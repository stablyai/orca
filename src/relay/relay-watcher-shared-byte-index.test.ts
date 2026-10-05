import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process-protocol'
import { RelayDispatcher } from './dispatcher'
import type { RelayClientSinkOptions, RelayClientWrite } from './dispatcher-writer-sink'
import { encodeJsonRpcFrame } from './protocol'
import { emitRelayWatcherEvents } from './relay-watcher-event-emitter'

type WatcherPayload = { kind: string; absolutePath: string; isDirectory?: boolean }

function captureClient(highWaterMark: number, onFrame?: () => void) {
  const frames: Buffer[] = []
  let closed = 0
  const write: RelayClientWrite = (frame) => {
    frames.push(Buffer.from(frame))
    onFrame?.()
    return true
  }
  const options: RelayClientSinkOptions = {
    writableHighWaterMark: () => highWaterMark,
    writableLength: () => 0,
    close: () => {
      closed += 1
    }
  }
  return { frames, write, options, closed: () => closed }
}

function watcherBatch(root: string, count: number): WatcherProcessEvent[] {
  const separator = root.startsWith('/') ? '/' : '\\'
  return Array.from({ length: count }, (_, index): WatcherProcessEvent => ({
    type: index % 3 === 0 ? 'create' : index % 3 === 1 ? 'update' : 'delete',
    path: `${root}${separator}dir-${index % 7}${separator}quoted-"雪😀-${index}.txt`,
    ...(index % 2 === 0 ? { isDirectory: index % 10 === 0 } : {})
  }))
}

function payloads(events: readonly WatcherProcessEvent[]): WatcherPayload[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
  }))
}

function encoded(events: readonly WatcherPayload[], sequence: number): Buffer {
  return encodeJsonRpcFrame(
    { jsonrpc: '2.0', method: 'fs.changed', params: { events } },
    sequence,
    0
  )
}

// Size actual complete frames independently of the emitter's per-event arithmetic.
function expectedFrames(
  root: string,
  events: readonly WatcherProcessEvent[],
  capacity: number,
  firstSequence = 1
): Buffer[] {
  const mapped = payloads(events)
  const whole = encoded(mapped, firstSequence)
  if (whole.length <= capacity) {
    return [whole]
  }
  const separator = root.startsWith('/') ? '/' : '\\'
  const groups = new Map<string, WatcherPayload[]>()
  for (const event of mapped) {
    const parent = event.absolutePath.slice(0, event.absolutePath.lastIndexOf(separator))
    const group = groups.get(parent) ?? []
    group.push(event)
    groups.set(parent, group)
  }
  const ordered = [...groups.values()].flat()
  const frames: Buffer[] = []
  let index = 0
  while (index < ordered.length) {
    const sequence = firstSequence + frames.length
    let low = index
    let high = ordered.length
    while (low < high) {
      const end = Math.ceil((low + high + 1) / 2)
      if (encoded(ordered.slice(index, end), sequence).length <= capacity) {
        low = end
      } else {
        high = end - 1
      }
    }
    if (low === index) {
      frames.push(encoded([{ kind: 'overflow', absolutePath: root }], sequence))
      break
    }
    frames.push(encoded(ordered.slice(index, low), sequence))
    index = low
  }
  return frames
}

function eventLookupCount(calls: readonly (readonly unknown[])[]): number {
  return calls.filter(([key]) => {
    return typeof key === 'object' && key !== null && 'kind' in key && 'absolutePath' in key
  }).length
}

afterEach(() => vi.restoreAllMocks())

describe('relay watcher shared byte index', () => {
  it.each(['/folder-workspace', 'C:\\folder-workspace', '\\\\host\\share\\folder-workspace'])(
    'looks up each grouped event once while preserving every client frame for %s',
    (root) => {
      const clients = [captureClient(16384), captureClient(32768), captureClient(65536)]
      const dispatcher = new RelayDispatcher(clients[0].write, clients[0].options)
      dispatcher.attachClient(clients[1].write, clients[1].options)
      dispatcher.attachClient(clients[2].write, clients[2].options)
      const events = watcherBatch(root, 5000)
      try {
        const get = vi.spyOn(Map.prototype, 'get')
        emitRelayWatcherEvents(dispatcher, root, false, events)
        const lookups = eventLookupCount(get.mock.calls)
        get.mockRestore()
        for (const [index, capacity] of [12288, 24576, 49152].entries()) {
          expect(clients[index].frames).toEqual(expectedFrames(root, events, capacity))
          expect(clients[index].closed()).toBe(0)
        }
        expect(lookups).toBe(events.length)
      } finally {
        dispatcher.dispose()
      }
    }
  )

  it('keeps whole-batch clients in original order while chunking clients use directory order', () => {
    const root = '/folder-workspace'
    const clients = [captureClient(65536), captureClient(16384)]
    const dispatcher = new RelayDispatcher(clients[0].write, clients[0].options)
    dispatcher.attachClient(clients[1].write, clients[1].options)
    const events = watcherBatch(root, 200)
    try {
      emitRelayWatcherEvents(dispatcher, root, false, events)
      expect(clients[0].frames).toEqual(expectedFrames(root, events, 49152))
      expect(clients[0].frames).toHaveLength(1)
      expect(clients[1].frames).toEqual(expectedFrames(root, events, 12288))
      expect(clients[1].frames.length).toBeGreaterThan(1)
    } finally {
      dispatcher.dispose()
    }
  })

  it('does no event lookup for whole batches and rebuilds the index on each new emit', () => {
    const root = '/folder-workspace'
    const clients = [captureClient(16384), captureClient(65536)]
    const dispatcher = new RelayDispatcher(clients[0].write, clients[0].options)
    dispatcher.attachClient(clients[1].write, clients[1].options)
    try {
      const get = vi.spyOn(Map.prototype, 'get')
      emitRelayWatcherEvents(dispatcher, root, false, watcherBatch(root, 3))
      const smallLookups = eventLookupCount(get.mock.calls)
      get.mockClear()
      const events = watcherBatch(root, 1000)
      emitRelayWatcherEvents(dispatcher, root, false, events)
      events[0].path += '雪'.repeat(100)
      events[0].isDirectory = true
      emitRelayWatcherEvents(dispatcher, root, false, events)
      const largeLookups = eventLookupCount(get.mock.calls)
      get.mockRestore()
      expect(smallLookups).toBe(0)
      for (const [index, capacity] of [12288, 49152].entries()) {
        const freshFrames = expectedFrames(root, events, capacity)
        const firstSequence = clients[index].frames.length - freshFrames.length + 1
        expect(clients[index].frames.slice(-freshFrames.length)).toEqual(
          expectedFrames(root, events, capacity, firstSequence)
        )
      }
      expect(largeLookups).toBe(2 * events.length)
    } finally {
      dispatcher.dispose()
    }
  })

  it('preserves the delivered prefix and overflow frame for an oversized grouped event', () => {
    const root = '/folder-workspace'
    const clients = [captureClient(16384), captureClient(65536)]
    const dispatcher = new RelayDispatcher(clients[0].write, clients[0].options)
    dispatcher.attachClient(clients[1].write, clients[1].options)
    const events = watcherBatch(root, 300)
    events.splice(100, 0, { type: 'update', path: `${root}/oversized/${'x'.repeat(60000)}` })
    try {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      emitRelayWatcherEvents(dispatcher, root, false, events)
      for (const [index, capacity] of [12288, 49152].entries()) {
        expect(clients[index].frames).toEqual(expectedFrames(root, events, capacity))
        expect(clients[index].closed()).toBe(0)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not publish to a peer detached synchronously during the first client chunk', () => {
    const root = '/folder-workspace'
    let dispatcher: RelayDispatcher
    let peerId = 0
    const primary = captureClient(16384, () => dispatcher.detachClient(peerId))
    const peer = captureClient(65536)
    dispatcher = new RelayDispatcher(primary.write, primary.options)
    peerId = dispatcher.attachClient(peer.write, peer.options)
    const events = watcherBatch(root, 1000)
    try {
      emitRelayWatcherEvents(dispatcher, root, false, events)
      expect(primary.frames).toEqual(expectedFrames(root, events, 12288))
      expect(peer.frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })

  it('preserves first-publication errors before doing any event lookup', () => {
    const primary = captureClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const failure = new Error('publication failed')
    try {
      vi.spyOn(dispatcher, 'publishProducerNotification').mockImplementationOnce(() => {
        throw failure
      })
      const get = vi.spyOn(Map.prototype, 'get')
      expect(() =>
        emitRelayWatcherEvents(
          dispatcher,
          '/folder-workspace',
          false,
          watcherBatch('/folder-workspace', 5000)
        )
      ).toThrow(failure)
      const lookups = eventLookupCount(get.mock.calls)
      get.mockRestore()
      expect(lookups).toBe(0)
      expect(primary.frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })

  it('does no event lookup or publication for closed roots or detached clients', () => {
    const root = '/folder-workspace'
    const primary = captureClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const events = watcherBatch(root, 5000)
    try {
      const get = vi.spyOn(Map.prototype, 'get')
      emitRelayWatcherEvents(dispatcher, root, true, events)
      dispatcher.invalidateClient()
      emitRelayWatcherEvents(dispatcher, root, false, events)
      const lookups = eventLookupCount(get.mock.calls)
      get.mockRestore()
      expect(lookups).toBe(0)
      expect(primary.frames).toEqual([])
    } finally {
      dispatcher.dispose()
    }
  })
})
