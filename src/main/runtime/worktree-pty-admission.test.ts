import { describe, expect, it, vi } from 'vitest'
import { WORKTREE_PTY_SPAWN_DRAIN_TIMEOUT_MS, WorktreePtyAdmission } from './worktree-pty-admission'

describe('WorktreePtyAdmission', () => {
  it('drains admitted spawns and rejects new ones until teardown settles', async () => {
    const admission = new WorktreePtyAdmission()
    const releaseSpawn = admission.beginSpawn('w1')
    let releaseTeardown = () => {}
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseTeardown = () => resolve('removed')
        })
    )

    const teardown = admission.runTeardown('w1', operation)
    expect(operation).not.toHaveBeenCalled()
    expect(() => admission.beginSpawn('w1')).toThrow('Worktree teardown is in progress')

    releaseSpawn()
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
    expect(() => admission.beginSpawn('w1')).toThrow('Worktree teardown is in progress')
    releaseTeardown()

    await expect(teardown).resolves.toBe('removed')
    const releaseNextSpawn = admission.beginSpawn('w1')
    releaseNextSpawn()
  })

  it('keeps different worktrees independent', async () => {
    const admission = new WorktreePtyAdmission()
    const releaseSpawn = admission.beginSpawn('w1')
    const teardown = admission.runTeardown('w1', async () => undefined)

    const releaseOtherSpawn = admission.beginSpawn('w2')
    releaseOtherSpawn()
    releaseSpawn()

    await expect(teardown).resolves.toBeUndefined()
  })

  it('rejects a duplicate teardown owner from another removal entry point', async () => {
    const admission = new WorktreePtyAdmission()
    let releaseFirst = () => {}
    const order: string[] = []
    const first = admission.runTeardown(
      'w1',
      () =>
        new Promise<void>((resolve) => {
          order.push('first')
          releaseFirst = resolve
        })
    )
    const second = admission.runTeardown('w1', async () => order.push('second'))
    const secondRejection = expect(second).rejects.toThrow(
      'Worktree teardown is already in progress'
    )

    await vi.waitFor(() => expect(order).toEqual(['first']))
    await secondRejection
    releaseFirst()

    await first
    expect(order).toEqual(['first'])
  })

  it('fails a stuck drain closed and reopens admission without leaking the waiter', async () => {
    vi.useFakeTimers()
    try {
      const admission = new WorktreePtyAdmission()
      const releaseStuckSpawn = admission.beginSpawn('w1')
      const teardown = admission.runTeardown('w1', vi.fn())
      const rejection = expect(teardown).rejects.toThrow('Timed out draining PTY spawns: w1')

      await vi.advanceTimersByTimeAsync(WORKTREE_PTY_SPAWN_DRAIN_TIMEOUT_MS)
      await rejection

      const releaseNextSpawn = admission.beginSpawn('w1')
      releaseNextSpawn()
      releaseStuckSpawn()
      await expect(admission.runTeardown('w1', async () => 'removed')).resolves.toBe('removed')
    } finally {
      vi.useRealTimers()
    }
  })
})
