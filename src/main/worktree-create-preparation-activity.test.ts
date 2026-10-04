import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreparationActivity } from './worktree-create-preparation-activity'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginWorktreeCreate
} from './worktree-create-concurrency'

let now = 0

beforeEach(() => {
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  _resetWorktreeCreateConcurrencyForTests()
  vi.restoreAllMocks()
})

describe('createPreparationActivity', () => {
  it('reports the origin, including a re-arm the prefetch then asked for', () => {
    expect(createPreparationActivity('explicit').origin()).toBe('prefetch')
    expect(createPreparationActivity('automatic').origin()).toBe('rearm')
    const asked = createPreparationActivity('automatic')
    asked.requestedByPrefetch()
    expect(asked.origin()).toBe('rearm_then_prefetch')
  })

  it('keeps one piece of work for a tip refresh queued before the build finished', async () => {
    const activity = createPreparationActivity('explicit')
    const build = Promise.withResolvers<void>()
    activity.track(build.promise)
    const refresh = Promise.withResolvers<void>()
    const chained = build.promise.then(() => refresh.promise)
    activity.track(chained)
    const observer = beginWorktreeCreate()

    now = 3_000
    build.resolve()
    await build.promise
    now = 5_000
    refresh.resolve()
    await chained

    // Build is the build alone; idle runs from the refreshed checkout's ready.
    expect(activity.timesAt(9_000)).toEqual({ buildMs: 2_000, idleMs: 4_000 })
    expect(observer.end().preparations).toBe(1)
  })

  it('keeps the build time of the first build when a later refresh runs as new work', async () => {
    const activity = createPreparationActivity('automatic')
    const build = Promise.withResolvers<void>()
    activity.track(build.promise)
    now = 41_000
    build.resolve()
    await build.promise
    const observer = beginWorktreeCreate()

    now = 101_000
    const refresh = Promise.withResolvers<void>()
    activity.track(refresh.promise)
    now = 103_000
    refresh.resolve()
    await refresh.promise

    // A 40 s build stays 40 s; idle runs from the refresh's ready, not the build's.
    expect(activity.timesAt(113_000)).toEqual({ buildMs: 40_000, idleMs: 10_000 })
    expect(observer.end().preparations).toBe(1)
  })

  it('reports no idle time while a refresh is still running at the claim', async () => {
    const activity = createPreparationActivity('explicit')
    const build = Promise.resolve()
    activity.track(build)
    now = 2_000
    await build
    const refresh = Promise.withResolvers<void>()
    activity.track(refresh.promise)
    expect(activity.timesAt(5_000)).toEqual({ buildMs: 1_000, idleMs: 0 })
  })

  it('reports no idle time when the claim came before the work finished', async () => {
    const activity = createPreparationActivity('automatic')
    const build = Promise.withResolvers<void>()
    activity.track(build.promise)
    now = 4_000
    build.resolve()
    await build.promise
    expect(activity.timesAt(2_000)).toEqual({ buildMs: 3_000, idleMs: 0 })
  })
})
