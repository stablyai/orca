import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserResumeSpawnPacer } from './user-resume-spawn-pacer'

describe('user-resume spawn pacer', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(() => vi.useRealTimers())

  it('allows three starts, then waits for a settled spawn and a token', async () => {
    const pacer = createUserResumeSpawnPacer()
    const releases = await Promise.all(Array.from({ length: 3 }, () => pacer.take()))
    let fourthStarted = false
    const fourth = pacer.take().then((release) => {
      fourthStarted = true
      return release
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(fourthStarted).toBe(false)
    releases.forEach((release) => release())
    await vi.advanceTimersByTimeAsync(2499)
    expect(fourthStarted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fourthStarted).toBe(true)
    ;(await fourth)()
  })

  it('does not create extra tokens when a release is repeated', async () => {
    const pacer = createUserResumeSpawnPacer()
    const first = await Promise.all(Array.from({ length: 3 }, () => pacer.take()))
    first.forEach((release) => {
      release()
      release()
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const second = await Promise.all(Array.from({ length: 3 }, () => pacer.take()))
    let fourthStarted = false
    const fourth = pacer.take().then((release) => {
      fourthStarted = true
      return release
    })
    second.forEach((release) => release())
    await vi.advanceTimersByTimeAsync(2499)
    expect(fourthStarted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fourthStarted).toBe(true)
    ;(await fourth)()
  })

  it('does not strand later starts when a token waiter is canceled', async () => {
    const pacer = createUserResumeSpawnPacer()
    const releases = await Promise.all(Array.from({ length: 3 }, () => pacer.take()))
    releases.forEach((release) => release())
    const controller = new AbortController()
    const canceled = pacer.take(controller.signal)
    const rejected = expect(canceled).rejects.toThrow('canceled')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('canceled'))
    const later = pacer.take()
    await vi.advanceTimersByTimeAsync(2500)
    await rejected
    ;(await later)()
  })

  it('removes a canceled slot waiter without consuming the next slot', async () => {
    const pacer = createUserResumeSpawnPacer()
    const releases = await Promise.all(Array.from({ length: 3 }, () => pacer.take()))
    const controller = new AbortController()
    const canceled = pacer.take(controller.signal)
    const rejected = expect(canceled).rejects.toThrow('canceled')
    controller.abort(new Error('canceled'))
    await rejected
    releases.forEach((release) => release())
    const later = pacer.take()
    await vi.advanceTimersByTimeAsync(2500)
    ;(await later)()
  })
})
