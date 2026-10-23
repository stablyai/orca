import { describe, expect, it } from 'vitest'
import { AssignmentIdentityQueue } from './assignment-identity-queue.js'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('AssignmentIdentityQueue', () => {
  it('serializes operations for the same assignment', async () => {
    const queue = new AssignmentIdentityQueue()
    const firstStarted = deferred()
    const firstRelease = deferred()
    const started: string[] = []
    const identity = { userId: 'user-1', relayHostId: 'host-1' }

    const first = queue.run(identity, async () => {
      started.push('first')
      firstStarted.resolve()
      await firstRelease.promise
    })
    const second = queue.run(identity, async () => {
      started.push('second')
    })

    await firstStarted.promise
    expect(started).toEqual(['first'])
    firstRelease.resolve()
    await Promise.all([first, second])
    expect(started).toEqual(['first', 'second'])
  })

  it('allows different assignments to run concurrently', async () => {
    const queue = new AssignmentIdentityQueue()
    const release = deferred()
    const started: string[] = []

    const first = queue.run({ userId: 'user-1', relayHostId: 'host-1' }, async () => {
      started.push('first')
      await release.promise
    })
    const second = queue.run({ userId: 'user-2', relayHostId: 'host-1' }, async () => {
      started.push('second')
    })

    await second
    expect(started).toEqual(['first', 'second'])
    release.resolve()
    await first
  })

  it('continues after a rejected operation', async () => {
    const queue = new AssignmentIdentityQueue()
    const identity = { userId: 'user-1', relayHostId: 'host-1' }

    const failed = queue.run(identity, async () => {
      throw new Error('failed')
    })
    const recovered = queue.run(identity, async () => 'recovered')

    await expect(failed).rejects.toThrow('failed')
    await expect(recovered).resolves.toBe('recovered')
  })
})
