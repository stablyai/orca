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
    health.note('conn-1', false)
    vi.advanceTimersByTime(119_000)
    health.note('conn-2', false)
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[relay] data attach failed cell=https://relay-c1.example streak=2'
    )
  })

  it('does not count one connection twice, e.g. a pending attach replayed after a rebind', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    health.note('conn-1', false)
    health.note('conn-1', false)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })

  it('leaves healthy and sporadic failures alone', () => {
    const onUnhealthy = vi.fn()
    const health = new RelayDataAttachHealth('https://relay-c1.example', onUnhealthy)
    // An opened dial in between breaks the streak.
    health.note('conn-1', false)
    health.note('conn-2', true)
    health.note('conn-3', false)
    // Failures further apart than the window are unrelated.
    vi.advanceTimersByTime(121_000)
    health.note('conn-4', false)
    expect(onUnhealthy).not.toHaveBeenCalled()
  })
})
