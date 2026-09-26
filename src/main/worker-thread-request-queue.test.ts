import type { Worker } from 'node:worker_threads'
import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerThreadRequestQueue } from './worker-thread-request-queue'

// Why a direct test (#20940): three subsystems now share this queue, and each
// client test can only observe the parts its own protocol happens to exercise.
// The contract constrained here is the queue's own — dispatch order, where the
// deadline clock starts, and when the respawn cap counts and clears — so a
// change to it fails here rather than in whichever client noticed first.

type Request = { id: number; label: string }
type Response = { id: number; label: string }

class FakeWorker {
  posted: Request[] = []
  terminated = false
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: Request): void {
    this.posted.push(request)
  }

  emit(event: string, arg?: unknown): void {
    // Copy first: the host removes its listeners synchronously during a fault.
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  /** Answer the request currently in flight. */
  respond(): void {
    const last = this.posted.at(-1)
    if (!last) {
      throw new Error('no request posted to fake worker')
    }
    this.emit('message', { id: last.id, label: last.label })
  }
}

const TIMEOUT_MS = 1_000
const IDLE_TEARDOWN_MS = 60_000
const MAX_CONSECUTIVE_DEATHS = 3

function makeQueue(workers: FakeWorker[]): WorkerThreadRequestQueue<Request, Response> {
  return new WorkerThreadRequestQueue<Request, Response>({
    factory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeWorker implements every Worker member LazyWorkerThreadHost touches (on/off/removeAllListeners/unref/terminate/postMessage); the rest of the Worker surface is never reached.
      return worker as unknown as Worker
    },
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
    createUnavailableError: (message) => new Error(`unavailable: ${message}`),
    describeTimeout: (timeoutMs) => `timed out after ${timeoutMs}ms`,
    describeExit: (code) => `exited with code ${code}`,
    describeCrashLoop: (lastError) => `crashed repeatedly (${lastError})`,
    onUnavailable: () => {}
  })
}

function send(
  queue: WorkerThreadRequestQueue<Request, Response>,
  label: string
): Promise<Response> {
  return queue.dispatch((id) => ({ id, label }), TIMEOUT_MS)
}

/** Resolve to the response or to the rejection, so a test can assert on either. */
function settle(promise: Promise<Response>): Promise<unknown> {
  return promise.catch((error: unknown) => error)
}

function labels(worker: FakeWorker): string[] {
  return worker.posted.map((request) => request.label)
}

describe('WorkerThreadRequestQueue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels queued requests without retiring active work and retires active cancellation', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)
    const active = new AbortController()
    const queued = new AbortController()
    const first = settle(
      queue.dispatch((id) => ({ id, label: 'active' }), TIMEOUT_MS, active.signal)
    )
    const second = settle(
      queue.dispatch((id) => ({ id, label: 'queued' }), TIMEOUT_MS, queued.signal)
    )
    const third = send(queue, 'survivor')
    queued.abort(new Error('queued cancelled'))
    await expect(second).resolves.toMatchObject({ message: 'queued cancelled' })
    expect(workers[0].terminated).toBe(false)
    active.abort(new Error('active cancelled'))
    await expect(first).resolves.toMatchObject({ message: 'active cancelled' })
    expect(workers[0].terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(labels(workers[1])).toEqual(['survivor'])
    workers[0].respond()
    workers[1].respond()
    await expect(third).resolves.toMatchObject({ label: 'survivor' })
    queue.dispose()
  })

  it('never starts an already aborted request and rejects all work on disposal', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)
    await expect(
      queue.dispatch(
        (id) => ({ id, label: 'aborted' }),
        TIMEOUT_MS,
        AbortSignal.abort(new Error('cancelled'))
      )
    ).rejects.toThrow('cancelled')
    expect(workers).toHaveLength(0)
    const active = settle(send(queue, 'active'))
    const queued = settle(send(queue, 'queued'))
    queue.dispose()
    await expect(active).resolves.toMatchObject({ message: 'Worker request queue disposed' })
    await expect(queued).resolves.toMatchObject({ message: 'Worker request queue disposed' })
    await expect(send(queue, 'later')).rejects.toThrow('disposed')
    expect(workers[0].terminated).toBe(true)
  })

  it.each([false, true])(
    'does not respawn for queued calls sharing the cancelled active signal (survivor: %s)',
    async (hasSurvivor) => {
      const workers: FakeWorker[] = []
      const queue = makeQueue(workers)
      const controller = new AbortController()
      const reason = new Error('scan cancelled')
      const pending = Array.from({ length: 8 }, (_, index) =>
        settle(
          queue.dispatch(
            (id) => ({ id, label: `cancelled-${index}` }),
            TIMEOUT_MS,
            controller.signal
          )
        )
      )
      const survivor = hasSurvivor ? send(queue, 'survivor') : undefined
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(8)

      controller.abort(reason)

      expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => reason))
      expect(workers[0].terminated).toBe(true)
      expect(workers).toHaveLength(hasSurvivor ? 2 : 1)
      expect(workers.flatMap(labels)).toEqual(
        hasSurvivor ? ['cancelled-0', 'survivor'] : ['cancelled-0']
      )
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      if (survivor) {
        workers[1].respond()
        await expect(survivor).resolves.toMatchObject({ label: 'survivor' })
      }
      queue.dispose()
    }
  )

  it('posts one request at a time and in the order it was dispatched', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    const first = send(queue, 'a')
    const second = send(queue, 'b')
    const third = send(queue, 'c')
    await Promise.resolve()

    expect(workers).toHaveLength(1)
    expect(labels(workers[0])).toEqual(['a'])

    workers[0].respond()
    await expect(first).resolves.toMatchObject({ label: 'a' })
    expect(labels(workers[0])).toEqual(['a', 'b'])

    workers[0].respond()
    await expect(second).resolves.toMatchObject({ label: 'b' })
    expect(labels(workers[0])).toEqual(['a', 'b', 'c'])

    workers[0].respond()
    await expect(third).resolves.toMatchObject({ label: 'c' })
  })

  it('starts each deadline when the call is posted, not when it was queued', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    const first = send(queue, 'slow')
    const queued = settle(send(queue, 'behind'))
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    // 'behind' has now waited nearly its whole deadline without being posted.
    workers[0].respond()
    await expect(first).resolves.toMatchObject({ label: 'slow' })
    expect(labels(workers[0])).toEqual(['slow', 'behind'])

    // A queue-inclusive clock would already have fired here.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    workers[0].respond()

    await expect(queued).resolves.toMatchObject({ label: 'behind' })
  })

  it('fires a posted call at its own deadline', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    const pending = settle(send(queue, 'silent'))
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

    expect(await pending).toMatchObject({ message: `timed out after ${TIMEOUT_MS}ms` })
    expect(workers[0].terminated).toBe(true)
  })

  it('stops respawning and fails the rest of the queue once deaths hit the cap', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    const dispatched = ['a', 'b', 'c', 'd'].map((label) => settle(send(queue, label)))
    await Promise.resolve()

    for (let death = 0; death < MAX_CONSECUTIVE_DEATHS; death++) {
      workers.at(-1)?.emit('error', new Error(`boom ${death}`))
    }

    // Three deaths consumed three calls; the fourth never got a worker.
    expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS)
    expect(labels(workers[0])).toEqual(['a'])
    expect(labels(workers[2])).toEqual(['c'])
    const settled = await Promise.all(dispatched)
    expect(settled.slice(0, 3)).toMatchObject([
      { message: 'boom 0' },
      { message: 'boom 1' },
      { message: 'boom 2' }
    ])
    expect(settled[3]).toMatchObject({ message: 'crashed repeatedly (boom 2)' })
  })

  it('clears the death count on a successful response mid-queue', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    // One burst, never idle between the faults: the queue stays non-empty
    // throughout, so only the success can clear the count.
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((label) => settle(send(queue, label)))
    await Promise.resolve()

    workers[0].emit('error', new Error('boom 0'))
    workers[1].emit('error', new Error('boom 1'))
    expect(await a).toMatchObject({ message: 'boom 0' })
    expect(await b).toMatchObject({ message: 'boom 1' })

    expect(labels(workers[2])).toEqual(['c'])
    workers[2].respond()
    expect(await c).toMatchObject({ label: 'c' })

    expect(labels(workers[2])).toEqual(['c', 'd'])
    workers[2].emit('error', new Error('boom 2'))
    expect(await d).toMatchObject({ message: 'boom 2' })

    // Without the reset that fault is the third consecutive death and 'e' is
    // drained with the crash-loop message instead of posted to a new worker.
    expect(labels(workers[3])).toEqual(['e'])
    workers[3].respond()
    expect(await e).toMatchObject({ label: 'e' })
  })

  it('clears the death count when a fresh burst starts from full idle', async () => {
    const workers: FakeWorker[] = []
    const queue = makeQueue(workers)

    for (const label of ['a', 'b']) {
      const lone = settle(send(queue, label))
      await Promise.resolve()
      workers.at(-1)?.emit('error', new Error(`boom ${label}`))
      expect(await lone).toMatchObject({ message: `boom ${label}` })
    }
    expect(workers).toHaveLength(2)

    // Both deaths drained to an empty queue, so this burst is new work.
    const active = settle(send(queue, 'c'))
    const behind = settle(send(queue, 'd'))
    await Promise.resolve()
    workers[2].emit('error', new Error('boom c'))

    expect(await active).toMatchObject({ message: 'boom c' })
    // Without the reset this would be the third consecutive death and 'd' would
    // have been drained with the crash-loop message instead of posted.
    expect(labels(workers[3])).toEqual(['d'])
    workers[3].respond()
    expect(await behind).toMatchObject({ label: 'd' })
  })
})
