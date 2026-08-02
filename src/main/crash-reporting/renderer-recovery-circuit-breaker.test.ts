import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
  RendererRecoveryCircuitBreaker
} from './renderer-recovery-circuit-breaker'

describe('RendererRecoveryCircuitBreaker', () => {
  it('allows recoveries up to the limit, then opens', () => {
    const breaker = new RendererRecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 3 })

    // A tight crash loop: renderer dies and is reloaded every ~800ms.
    expect(breaker.registerRecoveryAttempt(0)).toEqual({ allowed: true, recentRecoveryCount: 1 })
    expect(breaker.registerRecoveryAttempt(800)).toEqual({ allowed: true, recentRecoveryCount: 2 })
    expect(breaker.registerRecoveryAttempt(1_600)).toEqual({
      allowed: true,
      recentRecoveryCount: 3
    })
    // 4th within the window: breaker is open, no further auto-reload.
    expect(breaker.registerRecoveryAttempt(2_400)).toEqual({
      allowed: false,
      recentRecoveryCount: 3
    })
    expect(breaker.registerRecoveryAttempt(3_200)).toEqual({
      allowed: false,
      recentRecoveryCount: 3
    })
  })

  it('reopens once stale attempts age out of the rolling window', () => {
    const breaker = new RendererRecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 3 })

    // Stored attempts after the loop: [0, 1000, 2000] (the 4th is rejected).
    breaker.registerRecoveryAttempt(0)
    breaker.registerRecoveryAttempt(1_000)
    breaker.registerRecoveryAttempt(2_000)
    expect(breaker.registerRecoveryAttempt(3_000).allowed).toBe(false)

    // At t=60_500 (cutoff 500), only 1000 and 2000 are still in the window.
    expect(breaker.recentRecoveryCount(60_500)).toBe(2)
    // Renderer survived long enough that all three attempts have aged out.
    expect(breaker.recentRecoveryCount(62_001)).toBe(0)
    expect(breaker.registerRecoveryAttempt(62_001).allowed).toBe(true)
  })

  it('does not count a single transient crash as a loop', () => {
    const breaker = new RendererRecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 3 })
    expect(breaker.registerRecoveryAttempt(0).allowed).toBe(true)
    // Hours later, an unrelated crash: still allowed (window long expired).
    expect(breaker.registerRecoveryAttempt(10_000_000).allowed).toBe(true)
  })

  it('reset() clears history so the next recovery is allowed', () => {
    const breaker = new RendererRecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 1 })
    expect(breaker.registerRecoveryAttempt(0).allowed).toBe(true)
    expect(breaker.registerRecoveryAttempt(100).allowed).toBe(false)
    breaker.reset()
    expect(breaker.registerRecoveryAttempt(200).allowed).toBe(true)
  })

  it('ships conservative defaults', () => {
    expect(DEFAULT_RENDERER_RECOVERY_WINDOW_MS).toBe(60_000)
    expect(DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES).toBe(3)
  })
})
