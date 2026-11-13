import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDataAttachHealth } from './relay-data-attach-health'

describe('RelayDataAttachHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports after dials for two distinct connections fail within two minutes', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', null, false)
    vi.advanceTimersByTime(119_000)
    health.note('conn-2', null, false)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[relay] data attach failed cell=https://relay-c1.example dial=unopened streak=2'
    )
  })

  it('does not count one connection twice, e.g. a pending attach replayed after a rebind', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', null, false)
    health.note('conn-1', null, false)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('leaves healthy and sporadic failures alone', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    // An opened dial in between breaks the streak.
    health.note('conn-1', null, false)
    health.note('conn-2', 300, false)
    health.note('conn-3', null, false)
    // Failures further apart than the window are unrelated.
    vi.advanceTimersByTime(121_000)
    health.note('conn-4', null, false)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('counts a slow open that ends before its first frame, which never clears the streak', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', 7_000, false)
    health.note('conn-2', 6_000, false)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)

    health.note('conn-3', null, false)
    health.note('conn-4', 5_001, false)
    expect(onUnhealthy).toHaveBeenCalledTimes(2)

    // A fast open still clears.
    health.note('conn-5', null, false)
    health.note('conn-6', 5_000, false)
    health.note('conn-7', null, false)
    expect(onUnhealthy).toHaveBeenCalledTimes(2)
  })

  it('does not count a slow open whose attach then succeeds (slow path, stall, wake from sleep)', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', 7_000, true)
    health.note('conn-2', 8_000, true)
    expect(onUnhealthy).not.toHaveBeenCalled()
    // ...and an attached slow open clears a pending failure.
    health.note('conn-3', null, false)
    health.note('conn-4', 7_000, true)
    health.note('conn-5', null, false)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })
})
