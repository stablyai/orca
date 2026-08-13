import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPresenceThrottle } from './discord-presence-throttle'
import type { DiscordActivity } from './discord-presence-activity'

const dummyActivity: DiscordActivity = {
  details: '1 agent working',
  state: 'Claude',
  assets: { large_image: 'orca', large_text: 'Orca' }
}

describe('createPresenceThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the first update immediately', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish)
    throttle(dummyActivity)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(dummyActivity)
  })

  it('coalesces rapid updates to the last one (trailing)', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish, 15000)
    throttle(dummyActivity)
    expect(publish).toHaveBeenCalledTimes(1) // leading

    const second: DiscordActivity = { ...dummyActivity, details: '2 agents working' }
    const third: DiscordActivity = { ...dummyActivity, details: '3 agents working' }

    throttle(second)
    throttle(third)

    // Only leading published so far
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(dummyActivity)

    // Advance past the interval
    vi.advanceTimersByTime(15000)

    // Trailing fires with the last value
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith(third)
  })

  it('does not publish trailing if value did not change', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish, 15000)

    throttle(dummyActivity) // leading
    throttle(dummyActivity) // same value
    expect(publish).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(15000)
    // No trailing because value unchanged
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('suppresses updates during cooldown', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish, 15000)

    throttle(dummyActivity)
    expect(publish).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5000)
    throttle({ ...dummyActivity, details: 'mid-cooldown' })
    expect(publish).toHaveBeenCalledTimes(1) // still in cooldown

    vi.advanceTimersByTime(10000) // 15s from start
    expect(publish).toHaveBeenCalledTimes(2) // trailing fired
  })

  it('flush() runs pending update immediately', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish, 15000)

    throttle(dummyActivity) // leading
    expect(publish).toHaveBeenCalledTimes(1)

    const updated: DiscordActivity = { ...dummyActivity, details: 'updated' }
    throttle(updated) // queued
    expect(publish).toHaveBeenCalledTimes(1)

    throttle.flush()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith(updated)
  })

  it('flush() is a no-op when nothing is pending', () => {
    const publish = vi.fn()
    const throttle = createPresenceThrottle(publish, 15000)
    throttle(dummyActivity) // leading, no trailing pending
    expect(publish).toHaveBeenCalledTimes(1)
    throttle.flush()
    expect(publish).toHaveBeenCalledTimes(1)
  })
})