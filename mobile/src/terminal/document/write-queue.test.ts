import { describe, expect, it } from 'vitest'
import {
  documentScopePreamble,
  generatedDocumentModule
} from './generated-document-region.test-support'

// Why: this block runs inside the WebView document, so the tests evaluate the document's own text
// against the scope object the document builds rather than asserting on the source string. The
// pre-change source is derived from the shipped one and kept as the differential oracle so the two
// cannot drift apart.
const WRITE_QUEUE_SOURCE = await generatedDocumentModule('write-queue')
const CLEARED_SLOT_STATEMENT = '    scope.writeQueue[scope.writeQueueHead] = void 0;\n'
const PREVIOUS_WRITE_QUEUE_SOURCE = WRITE_QUEUE_SOURCE.replace(CLEARED_SLOT_STATEMENT, '')

type QueueSnapshot = { slots: unknown[]; head: number }

type WriteQueueRuntime = {
  enqueue: (data: unknown) => void
  enqueueBoundary: (callback: () => void) => void
  next: () => unknown
  pump: () => void
  reset: () => void
  afterDrained: (callback: () => void) => void
  setGeneration: (generation: number) => void
  snapshot: () => QueueSnapshot
}

type WriteQueueHarness = WriteQueueRuntime & {
  writes: string[]
  pendingWrites: Array<() => void>
  flushWrite: () => void
  queuedCodeUnits: () => number
}

function createWriteQueue(source: string): WriteQueueHarness {
  const writes: string[] = []
  const pendingWrites: Array<() => void> = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the body's return literal names exactly the eight entries below.
  const factory = new Function(
    'recordWrite',
    `${documentScopePreamble()}
      scope.ready = true;
      scope.term = { write: function(data, done) { recordWrite(data, done); } };
      ${source}
      return {
        enqueue: enqueueWrite,
        enqueueBoundary: enqueueWriteBoundary,
        next: nextQueuedWrite,
        pump: function() { pumpWrites(scope.terminalGeneration); },
        reset: resetWriteQueue,
        afterDrained: afterWritesDrained,
        setGeneration: function(next) { scope.terminalGeneration = next; },
        snapshot: function() { return { slots: scope.writeQueue.slice(), head: scope.writeQueueHead }; }
      };`
  ) as (recordWrite: (data: string, done: () => void) => void) => WriteQueueRuntime
  const runtime = factory((data, done) => {
    writes.push(data)
    pendingWrites.push(done)
  })
  return {
    ...runtime,
    writes,
    pendingWrites,
    flushWrite: () => {
      const done = pendingWrites.shift()
      expect(done).toBeTypeOf('function')
      done?.()
    },
    queuedCodeUnits: () =>
      runtime
        .snapshot()
        .slots.reduce<number>(
          (total, slot) => total + (typeof slot === 'string' ? slot.length : 0),
          0
        )
  }
}

function drain(queue: WriteQueueHarness): void {
  queue.pump()
  let guard = 0
  while (queue.pendingWrites.length > 0) {
    queue.flushWrite()
    if (++guard > 10_000) {
      throw new Error('write queue did not drain')
    }
  }
}

const IMPLEMENTATIONS: Array<[string, string]> = [
  ['shipped', WRITE_QUEUE_SOURCE],
  ['previous', PREVIOUS_WRITE_QUEUE_SOURCE]
]

describe('terminal WebView write queue', () => {
  it('keeps the pre-change oracle distinct from the shipped source', () => {
    expect(WRITE_QUEUE_SOURCE).toContain(CLEARED_SLOT_STATEMENT)
    expect(PREVIOUS_WRITE_QUEUE_SOURCE).not.toContain(
      'scope.writeQueue[scope.writeQueueHead] = void 0;'
    )
    expect(PREVIOUS_WRITE_QUEUE_SOURCE.length).toBe(
      WRITE_QUEUE_SOURCE.length - CLEARED_SLOT_STATEMENT.length
    )
  })

  // Distinct contents per chunk: with one shared string the sum below would count the same
  // 64 KB string 128 times and read identically even if nothing were released.
  function distinctChunks(count: number, codeUnits: number): string[] {
    return Array.from({ length: count }, (_v, i) => {
      const marker = `chunk-${i}:`
      return marker + String.fromCharCode(0x61 + (i % 26)).repeat(codeUnits - marker.length)
    })
  }

  it('enqueues chunks with distinct contents, so summed lengths are real retained data', () => {
    const chunks = distinctChunks(128, 65_536)
    expect(new Set(chunks).size).toBe(chunks.length)
    expect(new Set(chunks.map((chunk) => chunk.length))).toEqual(new Set([65_536]))
  })

  // The measured quantity is a count of queue-reachable string code units, not heap bytes:
  // xterm may still hold the submitted chunk, so this proves only that the queue released it.
  it('retains one chunk instead of every dequeued chunk after 127 of 128 dequeues', () => {
    const CHUNK_CODE_UNITS = 65_536
    const CHUNK_COUNT = 128
    const chunks = distinctChunks(CHUNK_COUNT, CHUNK_CODE_UNITS)
    const measure = (source: string): number => {
      const queue = createWriteQueue(source)
      for (const chunk of chunks) {
        queue.enqueue(chunk)
      }
      for (let i = 0; i < CHUNK_COUNT - 1; i++) {
        queue.next()
      }
      return queue.queuedCodeUnits()
    }

    expect(measure(PREVIOUS_WRITE_QUEUE_SOURCE)).toBe(CHUNK_CODE_UNITS * CHUNK_COUNT)
    expect(measure(WRITE_QUEUE_SOURCE)).toBe(CHUNK_CODE_UNITS)
  })

  // Compaction is gated on writeQueueHead * 2 > writeQueue.length, so the pre-change retention
  // window grows with the backlog rather than sitting at a fixed cap.
  it.each([
    [1_000, 500],
    [10_000, 5_000]
  ])('at backlog %i the head reaches %i before any compaction', (backlog, dequeues) => {
    const chunks = distinctChunks(backlog, 64)
    const measure = (source: string): { codeUnits: number; head: number; slots: number } => {
      const queue = createWriteQueue(source)
      for (const chunk of chunks) {
        queue.enqueue(chunk)
      }
      for (let i = 0; i < dequeues; i++) {
        queue.next()
      }
      const { head, slots } = queue.snapshot()
      return { codeUnits: queue.queuedCodeUnits(), head, slots: slots.length }
    }

    const previous = measure(PREVIOUS_WRITE_QUEUE_SOURCE)
    const shipped = measure(WRITE_QUEUE_SOURCE)
    // No compaction has run yet at this depth, in either implementation.
    expect(previous.head).toBe(dequeues)
    expect(shipped.head).toBe(dequeues)
    expect(previous.slots).toBe(backlog)
    expect(shipped.slots).toBe(backlog)
    // Pre-change: every consumed slot is still reachable. Shipped: only the pending ones.
    expect(previous.codeUnits).toBe(backlog * 64)
    expect(shipped.codeUnits).toBe((backlog - dequeues) * 64)
  })

  it.each(IMPLEMENTATIONS)('%s: drains writes in FIFO order', (_label, source) => {
    const queue = createWriteQueue(source)
    queue.enqueue('a')
    queue.enqueue('b')
    queue.enqueue('c')
    drain(queue)

    expect(queue.writes).toEqual(['a', 'b', 'c'])
  })

  it.each(IMPLEMENTATIONS)('%s: runs boundary callbacks between writes', (_label, source) => {
    const queue = createWriteQueue(source)
    const order: string[] = []
    queue.enqueue('replay')
    queue.enqueueBoundary(() => order.push('boundary'))
    queue.enqueue('live')
    queue.afterDrained(() => order.push('drained'))

    queue.pump()
    expect(order).toEqual([])
    queue.flushWrite()
    // The boundary runs once the replay write lands, before the live chunk is submitted.
    expect(order).toEqual(['boundary'])
    expect(queue.writes).toEqual(['replay', 'live'])
    queue.flushWrite()

    expect(order).toEqual(['boundary', 'drained'])
  })

  it.each(IMPLEMENTATIONS)('%s: submits callback-only and empty writes', (_label, source) => {
    const queue = createWriteQueue(source)
    const calls: string[] = []
    queue.enqueueBoundary(() => calls.push('first'))
    queue.enqueue('')
    queue.enqueueBoundary(() => calls.push('second'))
    queue.enqueue('')
    drain(queue)

    expect(calls).toEqual(['first', 'second'])
    // Empty chunks still reach xterm; the queue does not filter them.
    expect(queue.writes).toEqual(['', ''])
    expect(queue.snapshot()).toEqual({ slots: [], head: 0 })
  })

  it.each(IMPLEMENTATIONS)('%s: a reset mid-flight discards pending writes', (_label, source) => {
    const queue = createWriteQueue(source)
    queue.enqueue('first')
    queue.enqueue('dropped')
    queue.pump()
    expect(queue.writes).toEqual(['first'])

    queue.reset()
    queue.enqueue('after-reset')
    queue.flushWrite()

    expect(queue.writes).toEqual(['first', 'after-reset'])
  })

  it.each(IMPLEMENTATIONS)('%s: a stale generation stops the pump', (_label, source) => {
    const queue = createWriteQueue(source)
    queue.enqueue('first')
    queue.enqueue('second')
    queue.pump()
    queue.setGeneration(1)
    queue.flushWrite()

    expect(queue.writes).toEqual(['first'])
  })

  it.each(IMPLEMENTATIONS)('%s: reentrant enqueues are drained in order', (_label, source) => {
    const queue = createWriteQueue(source)
    queue.enqueue('first')
    queue.enqueueBoundary(() => queue.enqueue('reentrant'))
    queue.enqueue('second')
    drain(queue)

    expect(queue.writes).toEqual(['first', 'second', 'reentrant'])
  })

  it.each(IMPLEMENTATIONS)('%s: compacts consumed slots and keeps order', (_label, source) => {
    const queue = createWriteQueue(source)
    const total = 200
    const consumed = 129
    for (let i = 0; i < total; i++) {
      queue.enqueue(`chunk-${i}`)
    }
    const taken: unknown[] = []
    for (let i = 0; i < consumed; i++) {
      taken.push(queue.next())
    }

    expect(taken).toEqual(Array.from({ length: consumed }, (_v, i) => `chunk-${i}`))
    const { slots, head } = queue.snapshot()
    expect(head).toBe(0)
    expect(slots).toEqual(
      Array.from({ length: total - consumed }, (_v, i) => `chunk-${consumed + i}`)
    )
  })

  it.each(IMPLEMENTATIONS)('%s: resets once the queue is fully consumed', (_label, source) => {
    const queue = createWriteQueue(source)
    queue.enqueue('only')
    expect(queue.next()).toBe('only')
    expect(queue.next()).toBeUndefined()
    expect(queue.snapshot()).toEqual({ slots: [], head: 0 })
  })

  it('once compaction does fire, both implementations retain only pending chunks', () => {
    const chunks = distinctChunks(200, 1_024)
    const measure = (source: string): number => {
      const queue = createWriteQueue(source)
      for (const chunk of chunks) {
        queue.enqueue(chunk)
      }
      for (let i = 0; i < 129; i++) {
        queue.next()
      }
      return queue.queuedCodeUnits()
    }

    // A 200-deep backlog is shallow enough that head * 2 > length trips at 129; deeper
    // backlogs (see the table above) do not reach the gate and the two diverge.
    expect(measure(PREVIOUS_WRITE_QUEUE_SOURCE)).toBe(1_024 * 71)
    expect(measure(WRITE_QUEUE_SOURCE)).toBe(1_024 * 71)
  })
})
