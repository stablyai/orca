import { describe, expect, it, vi } from 'vitest'
import { WorktreePtyAdmission } from './worktree-pty-admission'

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

  it('serializes teardown owners from different removal entry points', async () => {
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
    const second = admission.runTeardown('w1', async () => {
      order.push('second')
    })

    await vi.waitFor(() => expect(order).toEqual(['first']))
    releaseFirst()

    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })
})
