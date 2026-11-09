import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileRelayBackgroundGraceTimer,
  RELAY_BACKGROUND_GRACE_MS
} from './mobile-relay-background-grace'

describe('MobileRelayBackgroundGraceTimer', () => {
  afterEach(() => vi.useRealTimers())

  it('detects expiry on resume when the background timer was suspended', () => {
    vi.useFakeTimers()
    let now = 1_000
    const timer = new MobileRelayBackgroundGraceTimer(
      {
        now: () => now,
        setTimer: vi.fn(() => setTimeout(() => {}, 0)),
        clearTimer: vi.fn()
      },
      vi.fn()
    )

    timer.arm()
    now += RELAY_BACKGROUND_GRACE_MS

    expect(timer.consumeExpired()).toBe(true)
    expect(timer.consumeExpired()).toBe(false)
  })
})
