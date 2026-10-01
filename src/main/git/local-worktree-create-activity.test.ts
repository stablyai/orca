import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLocalWorktreeCreateActivityForTests,
  createLocalWorktreeCreateDeferral,
  holdLocalWorktreeCreate,
  isBackgroundWorkHeldForLocalCreates,
  LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS,
  runWithLocalWorktreeCreateHold,
  whenLocalWorktreeCreatesSettle
} from './local-worktree-create-activity'

afterEach(() => {
  _resetLocalWorktreeCreateActivityForTests()
  vi.useRealTimers()
})

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return settled
}

describe('local worktree create activity', () => {
  it('resolves at once when no create is in flight', async () => {
    expect(await isSettled(whenLocalWorktreeCreatesSettle())).toBe(true)
  })

  it('waits until the last overlapping create settles', async () => {
    const first = holdLocalWorktreeCreate()
    const second = holdLocalWorktreeCreate()
    const idle = whenLocalWorktreeCreatesSettle()

    first()
    expect(await isSettled(idle)).toBe(false)
    second()
    expect(await isSettled(idle)).toBe(true)
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
  })

  it('treats a repeated release as one release', async () => {
    const first = holdLocalWorktreeCreate()
    const second = holdLocalWorktreeCreate()
    first()
    first()
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(true)
    second()
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
  })

  it('gives up waiting at the deadline so a stuck create cannot starve background work', async () => {
    vi.useFakeTimers()
    holdLocalWorktreeCreate()
    const idle = whenLocalWorktreeCreatesSettle()

    await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS - 1)
    expect(await isSettled(idle)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await isSettled(idle)).toBe(true)
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
  })

  it('counts the deadline from the first create, so a later waiter cannot wait a fresh one', async () => {
    vi.useFakeTimers()
    holdLocalWorktreeCreate()
    await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS - 1_000)
    const late = whenLocalWorktreeCreatesSettle()
    // An overlapping create joins the stretch instead of restarting its deadline.
    holdLocalWorktreeCreate()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await isSettled(late)).toBe(true)
    expect(await isSettled(whenLocalWorktreeCreatesSettle())).toBe(true)
  })

  it('holds again once a new stretch of creates starts', async () => {
    vi.useFakeTimers()
    const stuck = holdLocalWorktreeCreate()
    await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS)
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)

    stuck()
    holdLocalWorktreeCreate()
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(true)
    expect(await isSettled(whenLocalWorktreeCreatesSettle())).toBe(false)
  })

  it('releases the hold when the create throws', async () => {
    await expect(
      runWithLocalWorktreeCreateHold(async () => {
        expect(isBackgroundWorkHeldForLocalCreates()).toBe(true)
        throw new Error('create failed')
      })
    ).rejects.toThrow('create failed')
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
  })
})

describe('local worktree create deferral', () => {
  it('holds off while a create runs and wakes the producer when it settles', async () => {
    const onSettle = vi.fn()
    const deferral = createLocalWorktreeCreateDeferral(onSettle)
    expect(deferral.shouldDefer()).toBe(false)

    const release = holdLocalWorktreeCreate()
    expect(deferral.shouldDefer()).toBe(true)
    expect(deferral.shouldDefer()).toBe(true)
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(onSettle).toHaveBeenCalledOnce()
    expect(deferral.shouldDefer()).toBe(false)
  })

  it('stops holding off at the deadline until no create is in flight', async () => {
    vi.useFakeTimers()
    const onSettle = vi.fn()
    const deferral = createLocalWorktreeCreateDeferral(onSettle)
    const release = holdLocalWorktreeCreate()
    expect(deferral.shouldDefer()).toBe(true)

    await vi.advanceTimersByTimeAsync(LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS)
    expect(onSettle).toHaveBeenCalledOnce()
    expect(deferral.shouldDefer()).toBe(false)

    release()
    expect(deferral.shouldDefer()).toBe(false)
    holdLocalWorktreeCreate()
    // A new stretch of creates is held again.
    expect(deferral.shouldDefer()).toBe(true)
  })
})
