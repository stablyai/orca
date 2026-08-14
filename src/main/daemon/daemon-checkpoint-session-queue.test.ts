import { describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_SESSION_QUEUE_MAX_PENDING,
  CheckpointSessionQueue
} from './daemon-checkpoint-session-queue'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('CheckpointSessionQueue', () => {
  it('serializes operations for one session', async () => {
    const queue = new CheckpointSessionQueue()
    const order: string[] = []
    const first = deferred<void>()

    const a = queue.run('s', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
    })
    const b = queue.run('s', async () => {
      order.push('b:start')
    })

    await vi.waitFor(() => expect(order).toEqual(['a:start']))
    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('does not make one session wait on another', async () => {
    const queue = new CheckpointSessionQueue()
    const stalled = deferred<void>()
    let stalledEntered = false

    void queue
      .run('stalled', async () => {
        stalledEntered = true
        await stalled.promise
      })
      .catch(() => {})

    const healthy = await queue.run('healthy', async () => 'ran')

    // Why assert entry: a stall that never started would prove nothing about isolation.
    expect(stalledEntered).toBe(true)
    expect(healthy).toBe('ran')
    stalled.resolve()
  })

  it('resolves the fallback when the deadline fires and still runs the operation', async () => {
    const queue = new CheckpointSessionQueue()
    const stalled = deferred<void>()
    let completed = false

    const outcome = await queue.runWithDeadline(
      'stalled',
      async () => {
        await stalled.promise
        completed = true
        return 'durable'
      },
      5,
      'live'
    )

    expect(outcome).toBe('live')
    // Why: abandoning the wait must not abandon the write, or a reattach deadline
    // would drop durable history instead of merely delaying it.
    expect(completed).toBe(false)
    stalled.resolve()
    await vi.waitFor(() => expect(completed).toBe(true))
  })

  it('keeps a later waiter behind an abandoned operation', async () => {
    const queue = new CheckpointSessionQueue()
    const stalled = deferred<void>()
    const order: string[] = []

    expect(
      await queue.runWithDeadline<'ran' | 'timed-out'>(
        's',
        async () => {
          order.push('stalled:start')
          await stalled.promise
          order.push('stalled:end')
          return 'ran'
        },
        5,
        'timed-out'
      )
    ).toBe('timed-out')

    const later = queue.run('s', async () => {
      order.push('later')
    })
    await vi.waitFor(() => expect(order).toEqual(['stalled:start']))
    stalled.resolve()
    await later
    expect(order).toEqual(['stalled:start', 'stalled:end', 'later'])
  })

  it('reports saturation once the queue bound is reached and clears it after draining', async () => {
    const queue = new CheckpointSessionQueue()
    const blocker = deferred<void>()
    const pending: Promise<void>[] = []

    for (let index = 0; index < CHECKPOINT_SESSION_QUEUE_MAX_PENDING; index += 1) {
      expect(queue.isSaturated('s')).toBe(false)
      pending.push(queue.run('s', async () => await blocker.promise))
    }

    expect(queue.isSaturated('s')).toBe(true)
    expect(queue.isSaturated('other')).toBe(false)

    blocker.resolve()
    await Promise.all(pending)
    expect(queue.isSaturated('s')).toBe(false)
  })

  it('keeps a stalled session queued rather than admitting a second writer', async () => {
    const queue = new CheckpointSessionQueue()
    const stalled = deferred<void>()
    let secondEntered = false

    void queue.run('s', async () => await stalled.promise).catch(() => {})
    const second = queue.run('s', async () => {
      secondEntered = true
    })

    // Why this matters: two concurrent tmp-write/rename pairs in one session directory lose a
    // checkpoint, so a parked write must hold its slot rather than be dropped.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondEntered).toBe(false)
    stalled.resolve()
    await second
    expect(secondEntered).toBe(true)
  })

  it('does not strand a session after an operation rejects', async () => {
    const queue = new CheckpointSessionQueue()
    await expect(
      queue.run('s', async () => {
        throw new Error('checkpoint failed')
      })
    ).rejects.toThrow('checkpoint failed')

    expect(queue.isSaturated('s')).toBe(false)
    expect(await queue.run('s', async () => 'next')).toBe('next')
  })
})
