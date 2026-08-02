import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process-protocol'
import { RelayDispatcher } from './dispatcher'
import {
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES,
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DISPATCHER_CONTROL_QUEUE_MAX_FRAMES
} from './dispatcher-writer-admission'
import type { RelayClientSinkOptions, RelayClientWrite } from './dispatcher-writer-sink'
import { LEGACY_CLIENT_RETAINED_BYTES_LOW } from './legacy-relay-publication-ledger'
import { HEADER_LENGTH, parseJsonRpcMessage } from './protocol'
import { emitRelayWatcherEvents, emitRelayWatcherOverflow } from './relay-watcher-event-emitter'

type WatcherFrameEvent = { kind: string; absolutePath: string; isDirectory?: boolean }

function frameMessage(frame: Buffer): { method: string; params?: Record<string, unknown> } {
  const payloadLength = frame.readUInt32BE(9)
  const message = parseJsonRpcMessage(frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength))
  return 'method' in message
    ? { method: message.method, params: message.params as Record<string, unknown> | undefined }
    : { method: '' }
}

function frameMethod(frame: Buffer): string {
  return frameMessage(frame).method
}

function frameEvents(frame: Buffer): WatcherFrameEvent[] {
  const params = frameMessage(frame).params
  return (params?.events ?? []) as WatcherFrameEvent[]
}

function createRecordingSink(highWaterMark?: number): {
  frames: Buffer[]
  closes: () => number
  drainWaiters: (() => void)[]
  blockNextWrite: () => void
  write: RelayClientWrite
  options: RelayClientSinkOptions
} {
  const frames: Buffer[] = []
  const drainWaiters: (() => void)[] = []
  let closes = 0
  let blocked = false
  const write: RelayClientWrite = (frame) => {
    frames.push(Buffer.from(frame))
    if (blocked) {
      blocked = false
      return false
    }
    return true
  }
  const options: RelayClientSinkOptions = {
    ...(highWaterMark === undefined ? {} : { writableHighWaterMark: () => highWaterMark }),
    close: () => {
      closes += 1
    },
    waitWriteDrain: (callback) => {
      drainWaiters.push(callback)
      return () => {
        const index = drainWaiters.indexOf(callback)
        if (index >= 0) {
          drainWaiters.splice(index, 1)
        }
      }
    }
  }
  return {
    frames,
    closes: () => closes,
    drainWaiters,
    blockNextWrite: () => {
      blocked = true
    },
    write,
    options
  }
}

// A sink that acknowledges writes on demand, so frames can be held in flight one lane at a time.
function createCallbackSink(): {
  frames: Buffer[]
  settle: (index: number) => void
  write: RelayClientWrite
  options: RelayClientSinkOptions
} {
  const frames: Buffer[] = []
  const settlements: ((result: { ok: true }) => void)[] = []
  const write: RelayClientWrite = (frame, onSettled) => {
    frames.push(Buffer.from(frame))
    settlements.push(onSettled)
    return true
  }
  return {
    frames,
    settle: (index) => settlements[index]?.({ ok: true }),
    write,
    options: { supportsWriteCallback: true, close: () => {} }
  }
}

function watcherBatch(count: number): { type: 'create'; path: string; isDirectory: false }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    type: 'create' as const,
    path: `/workspace/project/src/module-${index}/component-${index}.tsx`,
    isDirectory: false as const
  }))
}

function parentDir(absolutePath: string): string {
  return absolutePath.slice(0, absolutePath.lastIndexOf('/'))
}

// Fills the 2 MB producer queue so every subsequent watcher batch is rejected on the producer lane.
function saturateProducerQueue(dispatcher: RelayDispatcher): void {
  let admitted = 0
  for (const chunk of [40_000, 1_000, 1]) {
    while (
      admitted < 5_000 &&
      dispatcher.tryNotifyPtyData({ paneId: 'pane', data: 'x'.repeat(chunk) })
    ) {
      admitted += 1
    }
  }
  expect(admitted).toBeGreaterThan(0)
  expect(admitted).toBeLessThan(5_000)
}

// Parks PTY frames in the producer queue of a stalled sink without filling it.
function parkProducerBytes(dispatcher: RelayDispatcher, bytes: number): number {
  const chunk = 'x'.repeat(40_000)
  let parked = 0
  while (parked < bytes && dispatcher.tryNotifyPtyData({ paneId: 'pane', data: chunk })) {
    parked += chunk.length
  }
  expect(parked).toBeGreaterThanOrEqual(bytes)
  return parked
}

// Parks PTY frames in ONE client's producer queue, leaving every peer's retention untouched.
function parkProducerBytesForClient(
  dispatcher: RelayDispatcher,
  clientId: number,
  bytes: number
): number {
  const chunk = 'x'.repeat(40_000)
  let parked = 0
  while (
    parked < bytes &&
    dispatcher.publishProducerNotification(clientId, 'pty.data', { paneId: 'pane', data: chunk })
  ) {
    parked += chunk.length
  }
  expect(parked).toBeGreaterThanOrEqual(bytes)
  return parked
}

function isOverflowFrame(frame: Buffer): boolean {
  return frameEvents(frame).some((event) => event.kind === 'overflow')
}

function watcherFrames(frames: readonly Buffer[]): Buffer[] {
  return frames.filter((frame) => frameMethod(frame) === 'fs.changed')
}

function deliveredEvents(events: readonly WatcherProcessEvent[]): WatcherFrameEvent[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
  }))
}

describe('relay watcher writer admission', () => {
  it('keeps watcher batches on the producer lane while overflow markers ride the control lane', () => {
    const sink = createRecordingSink()
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, [
        { type: 'create', path: '/workspace/first', isDirectory: false }
      ])
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      dispatcher.notifyClient(1, 'control.event')

      expect(sink.frames.map(frameMethod)).toEqual(['fs.changed'])
      sink.drainWaiters.shift()?.()
      // The marker now shares the control lane with control.event and drains ahead of the producer lanes.
      expect(sink.frames.map(frameMethod)).toEqual(['fs.changed', 'fs.changed', 'control.event'])
      expect(frameEvents(sink.frames[1])).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })
})

describe('relay watcher overflow suppression key', () => {
  it('keeps the source free of NUL bytes so git and grep still see text', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./relay-watcher-event-emitter.ts', import.meta.url))
    )
    expect(source.includes(0)).toBe(false)
  })

  it('scopes the outstanding marker per client as well as per root', () => {
    const primary = createRecordingSink(65536)
    const secondary = createRecordingSink(65536)
    primary.blockNextWrite()
    secondary.blockNextWrite()
    const dispatcher = new RelayDispatcher(primary.write, primary.options)

    try {
      dispatcher.attachClient(secondary.write, secondary.options)
      // Two clients, same root: a key that collapses them would silently desync the second tree.
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      primary.drainWaiters.shift()?.()
      secondary.drainWaiters.shift()?.()

      for (const sink of [primary, secondary]) {
        expect(sink.frames.filter((frame) => frameMethod(frame) === 'fs.changed')).toHaveLength(1)
        expect(sink.closes()).toBe(0)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('drops the marker instead of retaining it when the client is already gone', () => {
    const primary = createRecordingSink(65536)
    const secondary = createRecordingSink(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const secondaryId = dispatcher.attachClient(secondary.write, secondary.options)
    dispatcher.detachClient(secondaryId)
    // The race the emitter has to survive: the id list was sampled before the client went away.
    const activeIds = vi.spyOn(dispatcher, 'activeClientIds').mockReturnValue([secondaryId])
    const notify = vi.spyOn(dispatcher, 'tryNotifyClient')

    try {
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      // A second attempt proves nothing was retained: a removed client has no tree left to resync.
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(watcherFrames(secondary.frames)).toHaveLength(0)
    } finally {
      notify.mockRestore()
      activeIds.mockRestore()
      dispatcher.dispose()
    }
  })

  it('republishes an admitted marker the replaced sink never wrote', () => {
    const stalled = createRecordingSink(65536)
    const replacement = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(stalled.write, stalled.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      // Saturates the sink without filling the control queue, so the marker is admitted and then parked.
      dispatcher.notifyClient(clientId, 'control.warmup')
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(stalled.frames)).toHaveLength(0)

      // setWrite fails every queued frame; an admitted-but-unwritten marker is as lost as a rejected one.
      dispatcher.setWrite(replacement.write, replacement.options)

      expect(watcherFrames(replacement.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })

  it('republishes an admitted marker when invalidateClient precedes the sink replacement', () => {
    const stalled = createRecordingSink(65536)
    const replacement = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(stalled.write, stalled.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      dispatcher.notifyClient(clientId, 'control.warmup')
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(stalled.frames)).toHaveLength(0)

      // A dropped SSH channel invalidates the primary — a detach that keeps the id, so the marker the
      // failed settlement retains must survive it and ride out on the reconnected sink.
      dispatcher.invalidateClient()
      dispatcher.setWrite(replacement.write, replacement.options)

      expect(watcherFrames(replacement.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })

  it('retries a marker rejected by a full control queue once capacity returns', () => {
    const sink = createRecordingSink(65536)
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }

      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(sink.frames)).toHaveLength(0)
      expect(sink.closes()).toBe(0)

      // No second emit: the watcher has no further trigger, so the retry must come from the retained marker.
      sink.drainWaiters.shift()?.()
      expect(watcherFrames(sink.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('leaves a retained marker alone until the control lane actually frees a slot', () => {
    const sink = createCallbackSink()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      dispatcher.tryNotifyPtyData({ paneId: 'pane', data: 'x' })
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(sink.frames)).toHaveLength(0)

      const notify = vi.spyOn(dispatcher, 'tryNotifyClient')
      // Capacity fires for every lane: a producer settlement frees no control slot, so re-encoding
      // the marker here could only be rejected again.
      sink.settle(sink.frames.findIndex((frame) => frameMethod(frame) === 'pty.data'))
      expect(notify).not.toHaveBeenCalled()

      // A control settlement does free one, and the retained marker goes out on it.
      sink.settle(sink.frames.findIndex((frame) => frameMethod(frame) === 'control.0'))
      expect(watcherFrames(sink.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
      notify.mockRestore()
    } finally {
      dispatcher.dispose()
    }
  })

  it('waits until the control byte budget can admit the retained marker', () => {
    const sink = createCallbackSink()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      const markerParams = {
        events: [{ kind: 'overflow', absolutePath: '/workspace' }]
      }
      const markerBytes = dispatcher.notificationFrameBytes('fs.changed', markerParams)
      const emptyFillBytes = dispatcher.notificationFrameBytes('control.byte-fill', { data: '' })
      const fillDataBytes = DISPATCHER_CONTROL_QUEUE_MAX_BYTES - markerBytes + 1 - emptyFillBytes

      dispatcher.tryNotifyPtyData({ paneId: 'pane', data: 'x' })
      dispatcher.notifyClient(clientId, 'control.byte-fill', { data: 'x'.repeat(fillDataBytes) })
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(sink.frames)).toHaveLength(0)

      const notify = vi.spyOn(dispatcher, 'tryNotifyClient')
      sink.settle(sink.frames.findIndex((frame) => frameMethod(frame) === 'pty.data'))
      expect(notify).not.toHaveBeenCalled()

      sink.settle(sink.frames.findIndex((frame) => frameMethod(frame) === 'control.byte-fill'))
      expect(watcherFrames(sink.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
      notify.mockRestore()
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps a retained marker per root and sends each exactly once', () => {
    const sink = createRecordingSink(65536)
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }

      for (let index = 0; index < 3; index += 1) {
        emitRelayWatcherOverflow(dispatcher, '/workspace', false)
        emitRelayWatcherOverflow(dispatcher, '/other', false)
      }
      sink.drainWaiters.shift()?.()

      // A retained root must neither duplicate nor suppress a peer root's resync.
      expect(watcherFrames(sink.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' },
        { kind: 'overflow', absolutePath: '/other' }
      ])
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('republishes a retained marker against a replaced primary sink', () => {
    const stalled = createRecordingSink(65536)
    const replacement = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(stalled.write, stalled.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(stalled.frames)).toHaveLength(0)

      // setWrite replaces the sink without a detach, so the marker must follow the client, not the writer.
      dispatcher.setWrite(replacement.write, replacement.options)

      expect(watcherFrames(replacement.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })

  it('republishes a retained marker when invalidateClient precedes the sink replacement', () => {
    const stalled = createRecordingSink(65536)
    const replacement = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(stalled.write, stalled.options)

    try {
      const clientId = dispatcher.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(stalled.frames)).toHaveLength(0)

      // The SSH reconnect order: invalidateClient detaches the primary without retiring the id, so the
      // pending marker must survive that detach and ride out on the replacement sink.
      dispatcher.invalidateClient()
      dispatcher.setWrite(replacement.write, replacement.options)

      expect(watcherFrames(replacement.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })

  it('forgets a retained marker when the client detaches', () => {
    const primary = createRecordingSink(65536)
    const secondary = createRecordingSink(65536)
    secondary.blockNextWrite()
    const dispatcher = new RelayDispatcher(primary.write, primary.options)

    try {
      const secondaryId = dispatcher.attachClient(secondary.write, secondary.options)
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(secondaryId, `control.${index}`)
      }
      emitRelayWatcherOverflow(dispatcher, '/workspace', false)
      expect(watcherFrames(secondary.frames)).toHaveLength(0)

      dispatcher.detachClient(secondaryId)
      secondary.drainWaiters.shift()?.()

      expect(watcherFrames(secondary.frames)).toHaveLength(0)
      // The primary's own marker went out on its first attempt and stays unaffected.
      expect(watcherFrames(primary.frames).flatMap(frameEvents)).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
    } finally {
      dispatcher.dispose()
    }
  })
})

describe('relay watcher batch chunking', () => {
  it.each([
    [65536, 49152],
    [16384, 12288]
  ])('splits a 5000-event batch into frames that fit a %i-byte sink', (highWaterMark, capacity) => {
    const sink = createRecordingSink(highWaterMark)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const events = watcherBatch(5000)

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      expect(sink.frames.length).toBeGreaterThan(1)
      expect(sink.frames.every((frame) => frameMethod(frame) === 'fs.changed')).toBe(true)
      expect(sink.frames.every((frame) => frame.length <= capacity)).toBe(true)
      expect(sink.frames.flatMap(frameEvents)).toEqual(
        events.map((event) => ({
          kind: event.type,
          absolutePath: event.path,
          isDirectory: event.isDirectory
        }))
      )
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('encodes the empty envelope once instead of re-encoding candidate chunks', () => {
    const sink = createRecordingSink(16384)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const budget = vi.spyOn(dispatcher, 'producerEnvelopeBudget')

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, watcherBatch(5000))
      expect(budget).toHaveBeenCalledTimes(1)
      expect(sink.frames.flatMap(frameEvents)).toHaveLength(5000)
    } finally {
      budget.mockRestore()
      dispatcher.dispose()
    }
  })

  it('sizes each event once across clients that need different chunk cuts', () => {
    const primary = createRecordingSink(16384)
    const secondary = createRecordingSink(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stringify = vi.spyOn(JSON, 'stringify')
    const events = watcherBatch(5000)

    try {
      dispatcher.attachClient(secondary.write, secondary.options)
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      const sizedEvents = stringify.mock.calls.filter(([value]) => {
        if (typeof value !== 'object' || value === null) {
          return false
        }
        return 'kind' in value && 'absolutePath' in value
      })
      expect(sizedEvents).toHaveLength(events.length)
      expect(primary.frames.flatMap(frameEvents)).toHaveLength(events.length)
      expect(secondary.frames.flatMap(frameEvents)).toHaveLength(events.length)
    } finally {
      stringify.mockRestore()
      dispatcher.dispose()
    }
  })

  it('falls back to one overflow marker when a single event exceeds the frame budget', () => {
    const sink = createRecordingSink(65536)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, [
        { type: 'update', path: `/workspace/${'p'.repeat(60_000)}`, isDirectory: false }
      ])

      expect(sink.frames.map(frameMethod)).toEqual(['fs.changed'])
      expect(frameEvents(sink.frames[0])).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' }
      ])
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('emits the overflow marker on the control lane when a chunk is rejected by a full producer queue', () => {
    const sink = createRecordingSink(65536)
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      // Fill the 2 MB producer queue down to a residue smaller than a one-event fs.changed frame.
      saturateProducerQueue(dispatcher)

      emitRelayWatcherEvents(dispatcher, '/workspace', false, [
        { type: 'create', path: '/workspace/first', isDirectory: false }
      ])
      sink.drainWaiters.shift()?.()

      const markers = sink.frames.filter((frame) => frameMethod(frame) === 'fs.changed')
      expect(markers).toHaveLength(1)
      expect(frameEvents(markers[0])).toEqual([{ kind: 'overflow', absolutePath: '/workspace' }])
      // Control lane preempts: the marker lands before the producer frames still queued behind it.
      expect(sink.frames.indexOf(markers[0])).toBeLessThan(sink.frames.length - 1)
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps at most one outstanding overflow marker per root without closing the client', () => {
    const sink = createRecordingSink(65536)
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      saturateProducerQueue(dispatcher)

      // More rejected batches than the 256-frame control queue can hold: one marker each would close the link.
      for (let index = 0; index < 300; index += 1) {
        emitRelayWatcherEvents(dispatcher, '/workspace', false, [
          { type: 'create', path: `/workspace/file-${index}`, isDirectory: false }
        ])
      }
      // A second root must still get its own marker, or that tree silently desyncs.
      emitRelayWatcherEvents(dispatcher, '/other', false, [
        { type: 'create', path: '/other/file', isDirectory: false }
      ])
      expect(sink.closes()).toBe(0)

      sink.drainWaiters.shift()?.()
      const markers = sink.frames
        .filter((frame) => frameMethod(frame) === 'fs.changed')
        .flatMap(frameEvents)
      expect(markers).toEqual([
        { kind: 'overflow', absolutePath: '/workspace' },
        { kind: 'overflow', absolutePath: '/other' }
      ])
      expect(sink.closes()).toBe(0)

      // The slot clears once the marker drains, so a later batch can still resync the same root.
      emitRelayWatcherEvents(dispatcher, '/workspace', false, [
        { type: 'create', path: '/workspace/later', isDirectory: false }
      ])
      expect(
        sink.frames.filter((frame) => frameMethod(frame) === 'fs.changed').flatMap(frameEvents)
      ).toHaveLength(3)
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps one directory in one chunk when the batch interleaves directories', () => {
    const sink = createRecordingSink(16384)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const directoryCount = 8
    const replacedPath = '/workspace/project/src/module-7/component-0.tsx'
    const events: WatcherProcessEvent[] = [
      ...Array.from({ length: 200 }, (_unused, index) => ({
        type: 'create' as const,
        path: `/workspace/project/src/module-${index % directoryCount}/component-${Math.floor(index / directoryCount)}.tsx`,
        isDirectory: false
      })),
      { type: 'delete' as const, path: replacedPath }
    ]

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      expect(sink.frames.length).toBeGreaterThan(1)
      const frameDirs = sink.frames.map(
        (frame) => new Set(frameEvents(frame).map((event) => parentDir(event.absolutePath)))
      )
      const dirs = Array.from(new Set(events.map((event) => parentDir(event.path))))
      expect(dirs).toHaveLength(directoryCount)
      // Each directory in one frame; the renderer dedupes refreshes per payload, so extra frames = extra readDir RPCs.
      const refreshes = frameDirs.reduce((total, frameDir) => total + frameDir.size, 0)
      expect(refreshes).toBeLessThanOrEqual(directoryCount + sink.frames.length - 1)

      const delivered = sink.frames.flatMap(frameEvents)
      for (const dir of dirs) {
        const positions = delivered
          .map((event, index) => ({ event, index }))
          .filter((entry) => parentDir(entry.event.absolutePath) === dir)
          .map((entry) => entry.index)
        expect(positions.at(-1)! - positions[0]).toBe(positions.length - 1)
      }
      // Stable grouping keeps per-path order: the create still precedes the delete of the same path.
      expect(
        delivered.filter((event) => event.absolutePath === replacedPath).map((event) => event.kind)
      ).toEqual(['create', 'delete'])
      expect(delivered).toHaveLength(events.length)
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not report a drop for a batch it goes on to deliver in full', () => {
    const sink = createRecordingSink(16384)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      const events = watcherBatch(5000)
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      expect(sink.frames.length).toBeGreaterThan(1)
      expect(sink.frames.flatMap(frameEvents)).toHaveLength(events.length)
      // A "Dropped fs.changed" line here would both lie and burn the one-per-generation
      // suppression slot a genuine over-capacity drop needs.
      const lines = stderr.mock.calls.map(([line]) => String(line))
      expect(lines.filter((line) => line.includes('fs.changed'))).toEqual([])
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('sizes chunks near the byte minimum instead of overshooting it', () => {
    const sink = createRecordingSink(16384)
    const capacity = 12288
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, watcherBatch(5000))

      const totalBytes = sink.frames.reduce((total, frame) => total + frame.length, 0)
      expect(sink.frames.length).toBeLessThanOrEqual(Math.ceil(totalBytes / capacity) + 1)
      for (const frame of sink.frames.slice(0, -1)) {
        expect(frame.length).toBeGreaterThanOrEqual(capacity * 0.9)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('stops the chunk walk while the producer queue sits past its retention reserve', () => {
    const sink = createRecordingSink(65536)
    sink.blockNextWrite()
    const dispatcher = new RelayDispatcher(sink.write, sink.options)

    try {
      // Past the retention reserve but far from the 2 MB queue limit: every chunk would still be admitted.
      const parked = parkProducerBytes(dispatcher, LEGACY_CLIENT_RETAINED_BYTES_LOW)
      expect(parked).toBeLessThan(DEFAULT_PRODUCER_QUEUE_MAX_BYTES / 2 + 256 * 1024)

      emitRelayWatcherEvents(dispatcher, '/workspace', false, watcherBatch(5000))
      sink.drainWaiters.shift()?.()

      const watcherFrames = sink.frames.filter((frame) => frameMethod(frame) === 'fs.changed')
      expect(watcherFrames.map(isOverflowFrame)).toEqual([true])
      // The flood injected nothing: the interactive lane keeps the whole reserve instead of ~425 KB less.
      const injected = watcherFrames
        .filter((frame) => !isOverflowFrame(frame))
        .reduce((total, frame) => total + frame.length, 0)
      expect(injected).toBe(0)
      expect(injected).toBeLessThan(
        DEFAULT_PRODUCER_QUEUE_MAX_BYTES - LEGACY_CLIENT_RETAINED_BYTES_LOW
      )
      expect(sink.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('delivers a whole flood to a healthy client while a second client sits past its reserve', () => {
    const stalled = createRecordingSink(65536)
    const healthy = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(stalled.write, stalled.options)
    const events = watcherBatch(5000)

    try {
      dispatcher.attachClient(healthy.write, healthy.options)
      const stalledId = dispatcher.activeClientIds()[0]
      parkProducerBytesForClient(dispatcher, stalledId, LEGACY_CLIENT_RETAINED_BYTES_LOW)

      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)
      stalled.drainWaiters.shift()?.()

      // A resync forces a readDir per directory, so an unrelated peer's stall must never trigger one here.
      expect(watcherFrames(healthy.frames).some(isOverflowFrame)).toBe(false)
      expect(watcherFrames(healthy.frames).flatMap(frameEvents)).toEqual(deliveredEvents(events))
      expect(watcherFrames(stalled.frames).map(isOverflowFrame)).toEqual([true])
      expect(healthy.closes()).toBe(0)
      expect(stalled.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('stops the walk for the congested client while a healthy peer takes the whole flood', () => {
    const healthy = createRecordingSink(65536)
    const stalled = createRecordingSink(65536)
    stalled.blockNextWrite()
    const dispatcher = new RelayDispatcher(healthy.write, healthy.options)
    const events = watcherBatch(5000)

    try {
      // Reversed attach order from the peer-stall case: the gate must read the client being written to.
      const stalledId = dispatcher.attachClient(stalled.write, stalled.options)
      parkProducerBytesForClient(dispatcher, stalledId, LEGACY_CLIENT_RETAINED_BYTES_LOW)

      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)
      stalled.drainWaiters.shift()?.()

      const stalledWatcher = watcherFrames(stalled.frames)
      expect(stalledWatcher.map(isOverflowFrame)).toEqual([true])
      const injected = stalledWatcher
        .filter((frame) => !isOverflowFrame(frame))
        .reduce((total, frame) => total + frame.length, 0)
      // Nothing injected: the congested client keeps its whole reserve for interactive PTY frames.
      expect(injected).toBe(0)
      expect(watcherFrames(healthy.frames).some(isOverflowFrame)).toBe(false)
      expect(watcherFrames(healthy.frames).flatMap(frameEvents)).toEqual(deliveredEvents(events))
      expect(healthy.closes()).toBe(0)
      expect(stalled.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('still delivers a flood larger than the reserve while the sink keeps draining', () => {
    const sink = createRecordingSink(16384)
    const dispatcher = new RelayDispatcher(sink.write, sink.options)
    const events = watcherBatch(20_000)

    try {
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      const totalBytes = sink.frames.reduce((total, frame) => total + frame.length, 0)
      expect(totalBytes).toBeGreaterThan(LEGACY_CLIENT_RETAINED_BYTES_LOW)
      expect(sink.frames.some(isOverflowFrame)).toBe(false)
      expect(sink.frames.flatMap(frameEvents)).toHaveLength(events.length)
    } finally {
      dispatcher.dispose()
    }
  })

  it('chunks per client so a small sink never degrades a healthy one', () => {
    const healthy = createRecordingSink(65536)
    const small = createRecordingSink(16384)
    const dispatcher = new RelayDispatcher(healthy.write, healthy.options)

    try {
      dispatcher.attachClient(small.write, small.options)
      const events = watcherBatch(200)
      emitRelayWatcherEvents(dispatcher, '/workspace', false, events)

      const expected = events.map((event) => ({
        kind: event.type,
        absolutePath: event.path,
        isDirectory: event.isDirectory
      }))
      expect(healthy.frames).toHaveLength(1)
      expect(frameEvents(healthy.frames[0])).toEqual(expected)
      expect(small.frames.length).toBeGreaterThan(1)
      expect(small.frames.every((frame) => frame.length <= 12288)).toBe(true)
      expect(small.frames.flatMap(frameEvents)).toEqual(expected)
      expect(healthy.closes()).toBe(0)
      expect(small.closes()).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })
})
