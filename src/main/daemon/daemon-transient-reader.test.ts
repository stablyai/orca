import type { PendingStreamDataBatch, StreamQueueEntry } from './daemon-stream-keep-tail-drop'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { DaemonTransientReader } from './daemon-transient-reader'
import { attachStreamEventReader } from './daemon-client-ndjson-readers'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { TerminalSnapshotState } from '../../shared/terminal-snapshot-state'
import { TerminalSnapshotConsumption } from '../../shared/terminal-snapshot-consumption'
import { SessionTransientObservations } from './session-transient-observations'
import { SessionOutputPlane } from './session-output-plane'
import type { DaemonEvent } from './daemon-stream-events'

function readMeasuredProperty(
  target: StreamQueueEntry[],
  key: PropertyKey,
  receiver: unknown
): unknown {
  let current: object | null = target
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      const value: unknown = descriptor.value
      return 'value' in descriptor ? value : descriptor.get?.call(receiver)
    }
    const parent: unknown = Object.getPrototypeOf(current)
    current =
      parent !== null && (typeof parent === 'object' || typeof parent === 'function')
        ? parent
        : null
  }
  return undefined
}

function isQueueEntry(value: unknown): value is StreamQueueEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'data' in value &&
    typeof value.data === 'string'
  )
}

function isQueueMap(value: unknown): value is Map<string, StreamQueueEntry> {
  if (!(value instanceof Map)) {
    return false
  }
  for (const [key, entry] of value) {
    if (typeof key !== 'string' || !isQueueEntry(entry)) {
      return false
    }
  }
  return true
}

type MeasuredBatch = Pick<
  PendingStreamDataBatch,
  'queue' | 'queuedMetadataBytesBySession' | 'latestSnapshots' | 'discardedEntries'
>
function isMeasuredBatch(value: unknown): value is MeasuredBatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'queue' in value &&
    Array.isArray(value.queue) &&
    value.queue.every(isQueueEntry) &&
    (!('latestSnapshots' in value) ||
      value.latestSnapshots === undefined ||
      isQueueMap(value.latestSnapshots)) &&
    (!('discardedEntries' in value) ||
      value.discardedEntries === undefined ||
      typeof value.discardedEntries === 'number') &&
    'queuedMetadataBytesBySession' in value &&
    value.queuedMetadataBytesBySession instanceof Map &&
    [...value.queuedMetadataBytesBySession].every(
      ([key, bytes]) => typeof key === 'string' && typeof bytes === 'number'
    )
  )
}
function measuredBatch(batcher: DaemonStreamDataBatcher): MeasuredBatch {
  const batches: unknown = Object.getOwnPropertyDescriptor(batcher, 'pendingByClient')?.value
  if (!(batches instanceof Map)) {
    throw new Error('Expected actual pending-client map')
  }
  const batch: unknown = batches.get('client')
  if (!isMeasuredBatch(batch)) {
    throw new Error('Expected initialized actual client batch')
  }
  return batch
}

function measuredLatest(batch: MeasuredBatch): Map<string, StreamQueueEntry> {
  if (!batch.latestSnapshots) {
    throw new Error('Expected committed actual latest-state map')
  }
  return batch.latestSnapshots
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('complete terminal state delivery', () => {
  it('bounds unrelated queue visits for one latest-state update at N and 10N', () => {
    const visits: number[] = []
    for (const size of [10, 100]) {
      const socket = new Socket()
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }))
      const state = new TerminalSnapshotState()
      const sink = batcher.bindTransients('client', 'canonical')
      if (!sink) {
        throw new Error('Expected a live transient sink')
      }
      let visited = 0
      const nativeFilter = Array.prototype.filter
      let spy: ReturnType<typeof vi.spyOn> | undefined
      try {
        sink.install(state.snapshot(), 'incarnation', () => state.snapshot())
        for (let index = 0; index < size; index++) {
          batcher.enqueue('client', `unrelated-${index}`, 'x')
        }
        spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
          this: unknown[],
          predicate,
          thisArg
        ) {
          visited += this.length
          return nativeFilter.call(this, predicate, thisArg)
        })
        state.record({ kind: 'bell' })
        sink.stage(state.snapshot())
        sink.commit()
        visits.push(visited)
      } finally {
        spy?.mockRestore()
        batcher.clear()
        socket.destroy()
      }
    }
    expect(visits[0], `queue visits at N and 10N: ${visits.join(', ')}`).toBeLessThanOrEqual(2)
    expect(visits[1]).toBeLessThanOrEqual(2)
  })

  it('amortizes actual slot traversal and bounds tombstones while moving latest after ordinary output', () => {
    for (const size of [10, 100]) {
      const socket = new Socket()
      const events: DaemonEvent[] = []
      vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
        events.push(JSON.parse(String(args[0])))
        return true
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }))
      const state = new TerminalSnapshotState()
      const sink = batcher.bindTransients('client', 'canonical')!
      try {
        sink.install(state.snapshot(), 'incarnation', () => state.snapshot())
        for (let index = 0; index < size; index++) {
          batcher.enqueue('client', `other-${index}`, 'x')
        }
        const batch = measuredBatch(batcher)
        let visits = 0
        const wrap = (queue: StreamQueueEntry[]) =>
          new Proxy(queue, {
            get: (target, key, receiver) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                visits++
              }
              return readMeasuredProperty(target, key, receiver)
            }
          })
        let queue = wrap(batch.queue)
        Object.defineProperty(batch, 'queue', {
          get: () => queue,
          set: (value: StreamQueueEntry[]) => {
            queue = wrap(value)
          },
          configurable: true
        })
        const updates = size * 4
        for (let index = 0; index < updates; index++) {
          state.record({ kind: 'bell' })
          sink.stage(state.snapshot())
          sink.commit()
          expect(measuredLatest(batch).size).toBe(1)
          expect(batch.queue.length).toBeLessThanOrEqual(2 * (size + 2))
        }
        expect(visits).toBeLessThanOrEqual(4 * updates + size)
        batcher.enqueue('client', 'canonical', 'between')
        state.record({ kind: 'bell' })
        sink.stage(state.snapshot())
        sink.commit()
        batcher.flush('client')
        const own = events.filter((event) => event.sessionId === 'canonical')
        expect(own.map((event) => event.event)).toEqual([
          'terminalObservation',
          'data',
          'terminalObservation'
        ])
        expect(own[0]).toMatchObject({ payload: { effects: {} } })
        expect(own[1]).toMatchObject({ payload: { data: 'between' } })
        expect(own[2]).toMatchObject({ payload: { effects: { bell: { count: updates + 1 } } } })
        expect(measuredLatest(batch).size).toBe(0)
        expect(batch.discardedEntries).toBe(0)
        expect(batch.queuedMetadataBytesBySession.size).toBe(0)
        expect(batcher.queuedCharsForClient('client')).toBe(0)
        expect(visits).toBeLessThanOrEqual(8 * (updates + size))
      } finally {
        sink.dispose?.()
        batcher.clear()
        socket.destroy()
      }
    }
  })

  it('bounds actual queue work through dead latest slots, held flush, drain and disposal at N and 10N', () => {
    for (const size of [10, 100]) {
      const socket = new Socket()
      let deep = 256 * 1024
      Object.defineProperty(socket, 'writableLength', { get: () => deep })
      const writes = vi.spyOn(socket, 'write').mockReturnValue(true)
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }), {
        isSessionDroppable: () => true
      })
      const state = new TerminalSnapshotState()
      const sinks = Array.from({ length: size }, (_, index) =>
        batcher.bindTransients('client', `physical-${index}`)!
      )
      try {
        for (const sink of sinks) {
          sink.install(state.snapshot(), 'incarnation', () => state.snapshot())
        }
        const batch = measuredBatch(batcher)
        let operations = 0
        const wrap = (items: StreamQueueEntry[]) =>
          new Proxy(items, {
            get: (target, key, receiver) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                operations++
              }
              return readMeasuredProperty(target, key, receiver)
            },
            set: (target, key, value, receiver) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                operations++
              }
              return Reflect.set(target, key, value, receiver)
            },
            deleteProperty: (target, key) => {
              operations++
              return Reflect.deleteProperty(target, key)
            }
          })
        let queue = wrap(batch.queue)
        Object.defineProperty(batch, 'queue', {
          get: () => queue,
          set: (items: StreamQueueEntry[]) => {
            queue = wrap(items)
          },
          configurable: true
        })
        for (const sink of sinks) {
          sink.stage(state.snapshot())
          sink.commit()
        }
        const unrelated = 4 * size
        for (let index = 0; index < unrelated; index++) {
          batcher.enqueue('client', `held-${index}`, 'x'.repeat(8192))
        }
        state.record({ kind: 'bell' })
        for (const sink of sinks) {
          sink.stage(state.snapshot())
          sink.commit()
        }
        batcher.flush('client')
        expect(batch.discardedEntries).toBe(0)
        expect(measuredLatest(batch).size).toBe(size)
        expect(batcher.queuedCharsForClient('client')).toBe(unrelated * 8192)
        const beforeDrop = batcher.queuedCharsForClient('client')
        batcher.enqueue('client', 'dropper', 'x'.repeat(1200000))
        expect(batcher.queuedCharsForClient('client') - beforeDrop).toBeGreaterThan(0)
        expect(batcher.queuedCharsForClient('client') - beforeDrop).toBeLessThan(1200000)
        deep = 0
        batcher.flush('client')
        expect(writes.mock.calls.some(([line]) => String(line).includes('"dataGap"'))).toBe(true)
        sinks.forEach((sink) => sink.dispose?.())
        expect(batch.queue).toHaveLength(0)
        expect(measuredLatest(batch).size).toBe(0)
        expect(batch.queuedMetadataBytesBySession.size).toBe(0)
        expect(batcher.queuedCharsForClient('client')).toBe(0)
        expect(operations).toBeLessThanOrEqual(30 * (size + unrelated))
      } finally {
        sinks.forEach((sink) => sink.dispose?.())
        batcher.clear()
        socket.destroy()
      }
    }
  })

  it.each(['ndjson', 'binary-v1'] as const)(
    'recovers advancing effects once after a held %s gap without a FIFO',
    async (streamFraming) => {
      const socket = new Socket()
      const destination = new Socket()
      let deep = 0
      Object.defineProperty(socket, 'writableLength', { get: () => deep })
      const events: DaemonEvent[] = []
      const admission = new DaemonTransientReader((event) => events.push(event))
      const reader = attachStreamEventReader(
        destination,
        { streamFraming, remainder: Buffer.alloc(0) },
        (event) => admission.accept(event)
      )
      vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
        const line = args[0]
        destination.push(Buffer.isBuffer(line) ? line : Buffer.from(String(line)))
        return deep === 0
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket, streamFraming }), {
        isSessionDroppable: () => true
      })
      const state = new TerminalSnapshotState()
      const sink = batcher.bindTransients('client', 'canonical')!
      const consumption = new TerminalSnapshotConsumption()
      try {
        sink.install(state.snapshot(), 'incarnation', () => state.snapshot())
        batcher.flush('client')
        await tick()
        const first = events.find((event) => event.event === 'terminalObservation')
        expect(first?.sessionId).toBe('canonical')
        if (first?.event !== 'terminalObservation') {
          throw new Error('Missing initial state')
        }
        expect(consumption.consume(first.payload)?.effects).toEqual([])
        events.length = 0
        deep = 256 * 1024
        for (let ordinal = 1; ordinal <= 3; ordinal++) {
          state.record({ kind: 'command-started' })
          state.record({ kind: 'bell' })
          state.record({ kind: 'command-finished', exitCode: ordinal })
          state.state.rawEndSeq += 600_000
          batcher.enqueue('client', 'canonical', 'x'.repeat(600_000))
          sink.stage(state.snapshot())
          sink.commit()
          batcher.flush('client')
        }
        await tick()
        expect(events.filter((event) => event.event === 'terminalObservation')).toEqual([])
        deep = 0
        batcher.flush('client')
        await vi.waitFor(() =>
          expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(1)
        )
        expect(events.some((event) => event.event === 'dataGap')).toBe(true)
        const states = events.filter((event) => event.event === 'terminalObservation')
        expect(states).toHaveLength(1)
        const last = states[0]
        if (last.event !== 'terminalObservation') {
          throw new Error('Missing final state')
        }
        expect(events.at(-1)).toEqual(last)
        const consumed = consumption.consume(last.payload)
        expect(consumed?.effects.map((effect) => effect.fact.kind)).toEqual([
          'command-started',
          'bell',
          'command-finished'
        ])
        expect(last.payload.effects['command-started']?.count).toBe(3)
        expect(last.payload.effects['command-finished']?.fact).toEqual({
          kind: 'command-finished',
          exitCode: 3
        })
        expect(last.payload.current.commandOrdinal).toBe(3)
        expect(consumption.consume(last.payload)?.effects).toEqual([])
        expect(consumption.consume(first.payload)).toBeNull()
      } finally {
        batcher.clear()
        reader.detach()
        socket.destroy()
        destination.destroy()
      }
    }
  )

  it.each(['ndjson', 'binary-v1'] as const)(
    'keeps the physical installation before first live effect under %s backpressure',
    async (streamFraming) => {
      const socket = new Socket()
      const destination = new Socket()
      let deep = 256 * 1024
      Object.defineProperty(socket, 'writableLength', { get: () => deep })
      const events: DaemonEvent[] = []
      const admission = new DaemonTransientReader((event) => events.push(event))
      const reader = attachStreamEventReader(
        destination,
        { streamFraming, remainder: Buffer.alloc(0) },
        (event) => admission.accept(event)
      )
      vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
        const line = args[0]
        destination.push(Buffer.isBuffer(line) ? line : Buffer.from(String(line)))
        return deep === 0
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket, streamFraming }))
      const plane = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
      const emission = (data: string, start: number) => ({
        data,
        rawStartSeq: start,
        rawEndSeq: start + data.length,
        transformed: false
      })
      try {
        plane.emit(emission('\x07', 0))
        batcher.enqueue('client', 'canonical', 'x'.repeat(64 * 1024))
        plane.attachClient({
          transients: batcher.bindTransients('client', 'canonical'),
          onData: (data) => batcher.enqueue('client', 'canonical', data),
          onExit: () => {}
        })
        plane.emit(emission('\x07', 1))
        batcher.flush('client')
        await tick()
        expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(0)
        deep = 0
        batcher.flush('client')
        await tick()
        await vi.waitFor(() =>
          expect(events.filter((event) => event.event === 'terminalObservation')).toHaveLength(2)
        )
        const observations = events.filter((event) => event.event === 'terminalObservation')
        expect(observations).toHaveLength(2)
        expect(
          observations.map(
            (event) => event.event === 'terminalObservation' && event.payload.effects.bell?.count
          )
        ).toEqual([1, 2])
        const cursor = new TerminalSnapshotConsumption()
        const applied = observations.flatMap((event) =>
          event.event === 'terminalObservation'
            ? (cursor.consume(event.payload)?.effects ?? [])
            : []
        )
        expect(applied.map((effect) => effect.fact.kind)).toEqual(['bell'])
      } finally {
        plane.markDisposed()
        plane.disposeEmulator()
        batcher.clear()
        reader.detach()
        socket.destroy()
        destination.destroy()
      }
    }
  )

  it('holds state without DATA and captured old cleanup cannot erase its replacement', () => {
    const socket = new Socket()
    let deep = 256 * 1024
    Object.defineProperty(socket, 'writableLength', { get: () => deep })
    const events: DaemonEvent[] = []
    vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
      events.push(JSON.parse(String(args[0])))
      return deep === 0
    })
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }))
    const state = new TerminalSnapshotState()
    const old = batcher.bindTransients('client', 'canonical')!
    const successor = batcher.bindTransients('client', 'canonical')!
    try {
      old.install(state.snapshot(), 'incarnation', () => state.snapshot())
      state.record({ kind: 'bell' })
      successor.install(state.snapshot(), 'incarnation', () => state.snapshot())
      old.dispose?.()
      batcher.flush('client')
      expect(events.filter((event) => event.event === 'terminalObservation')).toEqual([])
      deep = 0
      batcher.flush('client')
      expect(events.filter((event) => event.event === 'terminalObservation')).toMatchObject([
        { payload: { effects: { bell: { count: 1 } } } }
      ])
    } finally {
      batcher.clear()
      socket.destroy()
    }
  })

  it('retains independent finishes and current command plus split title, status and Command Code evidence', () => {
    const source = new SessionTransientObservations(() => {}, false, 'command-code')
    try {
      source.observe('\x1b]133;C\x07output\x1b]133;D;0\x07\x1b]133;C\x07', 30)
      source.observe('\x1b]2;Working', 42)
      source.observe(' title\x07\n❯ implement fix\nThinking…\n', 80)
      const active = source.snapshot()
      expect(active.current.command).toBe('running')
      expect(active.current.commandOrdinal).toBe(2)
      expect(active.effects['command-finished']?.commandOrdinal).toBe(1)
      expect(active.current.title?.rawTitle).toBe('Working title')
      expect(active.current.commandCode).toMatchObject({
        armed: true,
        prompt: 'implement fix',
        phase: 'working'
      })
      source.observe('\n❯ Ask your question...\n', 110)
      expect(source.snapshot().effects['command-code-done']?.fact).toMatchObject({
        prompt: 'implement fix'
      })
    } finally {
      source.dispose()
    }
  })
})
