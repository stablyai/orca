import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileRelayBackgroundGraceTimer,
  RELAY_BACKGROUND_GRACE_MS
} from './mobile-relay-background-grace'

describe('MobileRelayBackgroundGraceTimer', () => {
  afterEach(() => vi.useRealTimers())

  it('expires once after the 30 second grace', async () => {
    vi.useFakeTimers()
    const onExpired = vi.fn()
    const timer = new MobileRelayBackgroundGraceTimer(
      { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
      onExpired
    )

    timer.arm()
    await vi.advanceTimersByTimeAsync(RELAY_BACKGROUND_GRACE_MS - 1)
    expect(onExpired).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onExpired).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RELAY_BACKGROUND_GRACE_MS)
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('detects expiry on resume when the background timer was suspended', () => {
    let now = 1_000
    const timer = new MobileRelayBackgroundGraceTimer(
      {
        now: () => now,
        setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
        clearTimer: vi.fn()
      },
      vi.fn()
    )

    timer.arm()
    now += RELAY_BACKGROUND_GRACE_MS

    expect(timer.consumeExpired()).toBe(true)
    expect(timer.consumeExpired()).toBe(false)
  })

  it('rejects a stale expiry callback after foreground cancellation', () => {
    let callback: (() => void) | null = null
    const onExpired = vi.fn()
    const timer = new MobileRelayBackgroundGraceTimer(
      {
        now: () => 1_000,
        setTimer: vi.fn((next) => {
          callback = next
          return 1 as unknown as ReturnType<typeof setTimeout>
        }),
        clearTimer: vi.fn()
      },
      onExpired
    )

    timer.arm()
    expect(timer.consumeExpired()).toBe(false)
    const staleCallback = callback as (() => void) | null
    staleCallback?.()

    expect(onExpired).not.toHaveBeenCalled()
  })
})
