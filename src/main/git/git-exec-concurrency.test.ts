import { afterEach, describe, expect, it } from 'vitest'
import {
  __getGitExecConcurrencyForTests,
  __resetGitExecConcurrencyForTests,
  __setGitExecMaxConcurrencyForTests,
  withGitExecSlot
} from './git-exec-concurrency'

afterEach(() => {
  __resetGitExecConcurrencyForTests()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('git-exec-concurrency', () => {
  it('never runs more than the configured max at once and drains the queue', async () => {
    __setGitExecMaxConcurrencyForTests(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []

    const runs = gates.map((gate, index) =>
      withGitExecSlot(async () => {
        started.push(index)
        await gate.promise
        return index
      })
    )

    await flush()
    // Only the first two acquire slots; the rest queue.
    expect(started).toEqual([0, 1])
    expect(__getGitExecConcurrencyForTests()).toMatchObject({ active: 2, queued: 2 })

    gates[0].resolve()
    await runs[0]
    await flush()
    // The freed slot is handed straight to the next queued task.
    expect(started).toEqual([0, 1, 2])
    expect(__getGitExecConcurrencyForTests().active).toBe(2)

    gates[1].resolve()
    gates[2].resolve()
    gates[3].resolve()
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3])
    expect(__getGitExecConcurrencyForTests()).toMatchObject({ active: 0, queued: 0 })
  })

  it('releases the slot even when the task throws', async () => {
    __setGitExecMaxConcurrencyForTests(1)

    await expect(
      withGitExecSlot(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(__getGitExecConcurrencyForTests().active).toBe(0)
    await expect(withGitExecSlot(async () => 'ok')).resolves.toBe('ok')
  })
})
