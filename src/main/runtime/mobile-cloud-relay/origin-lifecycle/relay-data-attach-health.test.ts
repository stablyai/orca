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
    health.note('conn-1', null)
    vi.advanceTimersByTime(119_000)
    health.note('conn-2', null)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[relay] data attach failed cell=https://relay-c1.example dial=unopened streak=2'
    )
  })

  it('does not count one connection twice, e.g. a pending attach replayed after a rebind', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', null)
    health.note('conn-1', null)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('leaves healthy and sporadic failures alone', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    // An opened dial in between breaks the streak.
    health.note('conn-1', null)
    health.note('conn-2', 300)
    health.note('conn-3', null)
    // Failures further apart than the window are unrelated.
    vi.advanceTimersByTime(121_000)
    health.note('conn-4', null)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('counts a slow open as a failure, and a slow open never clears the streak', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', 7_000)
    health.note('conn-2', 6_000)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)

    health.note('conn-3', null)
    health.note('conn-4', 5_001)
    expect(onUnhealthy).toHaveBeenCalledTimes(2)

    // A fast open still clears.
    health.note('conn-5', null)
    health.note('conn-6', 5_000)
    health.note('conn-7', null)
    expect(onUnhealthy).toHaveBeenCalledTimes(2)
  })
})
