import { describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_SESSION_QUEUE_MAX_PENDING,
  CheckpointSessionQueue
} from './daemon-checkpoint-session-queue'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

describe('CheckpointSessionQueue', () => {
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

    // Prove the stalled operation entered before testing other-session isolation.
    expect(stalledEntered).toBe(true)
    expect(healthy).toBe('ran')
    stalled.resolve()
  })

  it('resolves the fallback when the deadline fires and still runs the operation', async () => {
    const queue = new CheckpointSessionQueue()
    const stalled = deferred<void>()
    let completed = false
    const onDeadlineFired = vi.fn()

    const outcome = await queue.runWithDeadline(
      'stalled',
      async () => {
        await stalled.promise
        completed = true
        return 'durable'
      },
      5,
      'live',
      { onDeadline: onDeadlineFired }
    )

    expect(outcome).toBe('live')
    expect(onDeadlineFired).toHaveBeenCalledOnce()
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
