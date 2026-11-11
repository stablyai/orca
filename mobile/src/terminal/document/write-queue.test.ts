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
  // Count queue-reachable string units, not heap bytes; xterm may still retain submitted chunks.

  // Legacy compaction retention grows with backlog because it waits for consumed slots to exceed half the queue.

  it('hands xterm a 100 KB write as ordered slices of at most 16 KB', () => {
    const queue = createWriteQueue()
    const input = Array.from({ length: 100 * 1024 }, (_v, i) =>
      String.fromCharCode(0x61 + (i % 26))
    ).join('')
    queue.enqueue(input)
    drain(queue)

    expect(queue.writes.map((write) => write.length)).toEqual([
      16_384, 16_384, 16_384, 16_384, 16_384, 16_384, 4_096
    ])
    expect(queue.writes.join('')).toBe(input)
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
    expect(order).toEqual(['boundary'])
    expect(queue.writes).toEqual(['replay', 'live'])
    queue.flushWrite()

    expect(order).toEqual(['boundary', 'drained'])
  })

  it('discards pending writes after a reset mid-flight', () => {
    const queue = createWriteQueue()
    queue.enqueue('first')
    queue.pump()
    queue.enqueue('dropped')
    expect(queue.writes).toEqual(['first'])

    queue.reset()
    queue.enqueue('after-reset')
    queue.flushWrite()

    expect(queue.writes).toEqual(['first', 'after-reset'])
  })

  it('stops the pump for a stale generation', () => {
    const queue = createWriteQueue()
    queue.enqueue('first')
    queue.pump()
    queue.enqueue('second')
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

    expect(queue.writes).toEqual(['first', 'secondreentrant'])
  })
})
