import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import * as writeQueue from './write-queue'
import { terminalDocumentDouble } from './document-terminal-double.test-support'

type QueueSnapshot = { slots: unknown[]; head: number }

type WriteQueueRuntime = {
  enqueue: (data: string) => void
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

function createWriteQueue(): WriteQueueHarness {
  const writes: string[] = []
  const pendingWrites: Array<() => void> = []
  const scope = createTerminalDocumentScope()
  scope.ready = true
  scope.term = {
    ...terminalDocumentDouble().terminal,
    write: (data: string, done?: () => void) => {
      writes.push(data)
      if (done) {
        pendingWrites.push(done)
      }
    }
  }
  const module = writeQueue
  const runtime: WriteQueueRuntime = {
    enqueue: (data) => module.enqueueWrite(scope, data),
    enqueueBoundary: (callback) => module.enqueueWriteBoundary(scope, callback),
    next: () => module.nextQueuedWrite(scope),
    pump: () => module.pumpWrites(scope, scope.terminalGeneration),
    reset: () => module.resetWriteQueue(scope),
    afterDrained: (callback) => module.afterWritesDrained(scope, callback),
    setGeneration: (next) => {
      scope.terminalGeneration = next
    },
    snapshot: () => ({ slots: scope.writeQueue.slice(), head: scope.writeQueueHead })
  }
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

describe('terminal WebView write queue', () => {
  // Distinct contents per chunk: with one shared string the sum below would count the same
  // 64 KB string 128 times and read identically even if nothing were released.
  function distinctChunks(count: number, codeUnits: number): string[] {
    return Array.from({ length: count }, (_v, i) => {
      const marker = `chunk-${i}:`
      return marker + String.fromCharCode(0x61 + (i % 26)).repeat(codeUnits - marker.length)
    })
  }

  // The measured quantity is a count of queue-reachable string code units, not heap bytes:
  // xterm may still hold the submitted chunk, so this proves only that the queue released it.
  it('retains only the pending chunk after 127 of 128 dequeues', () => {
    const CHUNK_CODE_UNITS = 65_536
    const CHUNK_COUNT = 128
    const chunks = distinctChunks(CHUNK_COUNT, CHUNK_CODE_UNITS)
    const measure = (): number => {
      const queue = createWriteQueue()
      for (const chunk of chunks) {
        queue.enqueue(chunk)
      }
      for (let i = 0; i < CHUNK_COUNT - 1; i++) {
        queue.next()
      }
      return queue.queuedCodeUnits()
    }

    expect(measure()).toBe(CHUNK_CODE_UNITS)
  })

  // Compaction is gated on writeQueueHead * 2 > writeQueue.length, so the pre-change retention
  // window grows with the backlog rather than sitting at a fixed cap.
  it.each([
    [1_000, 500],
    [10_000, 5_000]
  ])('at backlog %i the head reaches %i before any compaction', (backlog, dequeues) => {
    const chunks = distinctChunks(backlog, 64)
    const measure = (): { codeUnits: number; head: number; slots: number } => {
      const queue = createWriteQueue()
      for (const chunk of chunks) {
        queue.enqueue(chunk)
      }
      for (let i = 0; i < dequeues; i++) {
        queue.next()
      }
      const { head, slots } = queue.snapshot()
      return { codeUnits: queue.queuedCodeUnits(), head, slots: slots.length }
    }

    const shipped = measure()
    // Reachability drops even before compaction.
    expect(shipped.head).toBe(dequeues)
    expect(shipped.slots).toBe(backlog)
    // Only pending string contents remain reachable from the queue.
    expect(shipped.codeUnits).toBe((backlog - dequeues) * 64)
  })

  it('drains writes in FIFO order', () => {
    const queue = createWriteQueue()
    queue.enqueue('a')
    queue.enqueue('b')
    queue.enqueue('c')
    drain(queue)

    expect(queue.writes).toEqual(['a', 'b', 'c'])
  })

  it('runs boundary callbacks between writes', () => {
    const queue = createWriteQueue()
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

  it('submits callback-only and empty writes', () => {
    const queue = createWriteQueue()
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

  it('discards pending writes after a reset mid-flight', () => {
    const queue = createWriteQueue()
    queue.enqueue('first')
    queue.enqueue('dropped')
    queue.pump()
    expect(queue.writes).toEqual(['first'])

    queue.reset()
    queue.enqueue('after-reset')
    queue.flushWrite()

    expect(queue.writes).toEqual(['first', 'after-reset'])
  })

  it('stops the pump for a stale generation', () => {
    const queue = createWriteQueue()
    queue.enqueue('first')
    queue.enqueue('second')
    queue.pump()
    queue.setGeneration(1)
    queue.flushWrite()

    expect(queue.writes).toEqual(['first'])
  })

  it('drains reentrant enqueues in order', () => {
    const queue = createWriteQueue()
    queue.enqueue('first')
    queue.enqueueBoundary(() => queue.enqueue('reentrant'))
    queue.enqueue('second')
    drain(queue)

    expect(queue.writes).toEqual(['first', 'second', 'reentrant'])
  })

  it('compacts consumed slots and keeps order', () => {
    const queue = createWriteQueue()
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

  it('resets once the queue is fully consumed', () => {
    const queue = createWriteQueue()
    queue.enqueue('only')
    expect(queue.next()).toBe('only')
    expect(queue.next()).toBeUndefined()
    expect(queue.snapshot()).toEqual({ slots: [], head: 0 })
  })
})
