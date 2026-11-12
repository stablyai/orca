import { describe, expect, it, vi } from 'vitest'
import { CheckpointSessionQueue } from '../daemon-checkpoint-session-queue'

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
})
