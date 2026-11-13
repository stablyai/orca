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

  it('re-asks after two consecutive failures within two minutes', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note(false)
    expect(onUnhealthy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(119_000)
    health.note(false)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[relay] data attach failed cell=https://relay-c1.example streak=2'
    )
  })

  it('leaves healthy and sporadic attaches alone', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    // A success in between breaks the streak.
    health.note(false)
    health.note(true)
    health.note(false)
    // Failures further apart than the window are unrelated.
    vi.advanceTimersByTime(121_000)
    health.note(false)
    for (let i = 0; i < 10; i++) {
      health.note(true)
    }
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('re-asks at most once per minute however often phones redial', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    for (let i = 0; i < 12; i++) {
      health.note(false)
      vi.advanceTimersByTime(5_000)
    }
    // Failures every 5s for a minute: one re-ask at t=5s, then none until 60s after it.
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    health.note(false)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    health.note(false)
    expect(onUnhealthy).toHaveBeenCalledTimes(2)
  })
})
