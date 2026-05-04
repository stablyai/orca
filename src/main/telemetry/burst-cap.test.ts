// Burst-cap behavior. These tests pin the three independent buckets (per-
// event token bucket, per-session global ceiling, consent-mutation bucket),
// the refill math, and the "exactly one warn per cap crossing per session"
// rule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getBurstCapStateForTests,
  consumeBurstToken,
  consumeConsentMutationToken,
  resetBurstCapsForSession
} from './burst-cap'

describe('burst-cap', () => {
  beforeEach(() => {
    resetBurstCapsForSession()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── Per-event token bucket ───────────────────────────────────────────

  it('allows up to 30 events/min for default-bucket event names', () => {
    // 30 tokens; 30 consumes should all succeed, 31st fails in the same
    // instant (no time has elapsed for refill).
    for (let i = 0; i < 30; i++) {
      expect(consumeBurstToken('app_opened')).toBe(true)
    }
    expect(consumeBurstToken('app_opened')).toBe(false)
  })

  it('allows up to 20 events/min for agent_error (tighter cap)', () => {
    for (let i = 0; i < 20; i++) {
      expect(consumeBurstToken('agent_error')).toBe(true)
    }
    expect(consumeBurstToken('agent_error')).toBe(false)
  })

  it('refills tokens continuously over the window', () => {
    // Drain the bucket…
    for (let i = 0; i < 30; i++) {
      consumeBurstToken('app_opened')
    }
    expect(consumeBurstToken('app_opened')).toBe(false)
    // …then advance half the refill window. Half of 30 = 15 tokens back.
    vi.advanceTimersByTime(30_000)
    let allowed = 0
    for (let i = 0; i < 20; i++) {
      if (consumeBurstToken('app_opened')) {
        allowed++
      }
    }
    expect(allowed).toBeGreaterThanOrEqual(14)
    expect(allowed).toBeLessThanOrEqual(15)
  })

  it('emits exactly one warn the first time the per-event cap is crossed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 30; i++) {
      consumeBurstToken('app_opened')
    }
    // Four overflow attempts — only one warn across all of them.
    consumeBurstToken('app_opened')
    consumeBurstToken('app_opened')
    consumeBurstToken('app_opened')
    consumeBurstToken('app_opened')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // ── Unknown event names ──────────────────────────────────────────────

  it('rejects unknown event names without creating a bucket (prevents unbounded Map growth)', () => {
    // The IPC handler casts any renderer string to `EventName`, so a
    // compromised renderer could flood unique bogus names. `consumeBurstToken`
    // must short-circuit before `getOrCreateBucket` to keep `perEventBuckets`
    // bounded by the compile-time `eventSchemas` size.
    const sizeBefore = _getBurstCapStateForTests().perEventBuckets.size
    // Cast through unknown — this is the renderer-controlled-string scenario.
    expect(consumeBurstToken('totally_bogus_event_name' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('another_fake_name' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('yet_another' as unknown as 'app_opened')).toBe(false)
    const sizeAfter = _getBurstCapStateForTests().perEventBuckets.size
    expect(sizeAfter).toBe(sizeBefore)
  })

  it('rejects Object.prototype key names without creating a bucket', () => {
    // Regression: the guard originally used `name in eventSchemas`, which
    // walks the prototype chain — so `'toString'`, `'__proto__'`,
    // `'constructor'`, etc. would all pass the check and seed buckets.
    // `Object.hasOwn` is an own-property check and rejects them.
    const sizeBefore = _getBurstCapStateForTests().perEventBuckets.size
    expect(consumeBurstToken('toString' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('__proto__' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('constructor' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('hasOwnProperty' as unknown as 'app_opened')).toBe(false)
    expect(consumeBurstToken('valueOf' as unknown as 'app_opened')).toBe(false)
    const sizeAfter = _getBurstCapStateForTests().perEventBuckets.size
    expect(sizeAfter).toBe(sizeBefore)
  })

  // ── Per-session ceiling ──────────────────────────────────────────────

  it('enforces the 1000-event per-session ceiling even if per-event caps refill', () => {
    // Cycle through enum event names to keep per-event buckets alive, and
    // advance time so the per-event bucket always has a token. After
    // ceiling is hit, all further attempts must fail regardless of which
    // event name.
    let accepted = 0
    for (let i = 0; i < 2000; i++) {
      vi.advanceTimersByTime(10_000) // generous refill
      if (consumeBurstToken('app_opened')) {
        accepted++
      }
    }
    expect(accepted).toBe(1000)
  })

  it('resets the per-session ceiling on resetBurstCapsForSession()', () => {
    for (let i = 0; i < 1500; i++) {
      vi.advanceTimersByTime(10_000)
      consumeBurstToken('app_opened')
    }
    resetBurstCapsForSession()
    expect(consumeBurstToken('app_opened')).toBe(true)
    expect(_getBurstCapStateForTests().perSessionCount).toBe(1)
  })

  // ── Consent-mutation bucket ──────────────────────────────────────────

  it('allows up to 5 consent mutations per session and then drops', () => {
    for (let i = 0; i < 5; i++) {
      expect(consumeConsentMutationToken()).toBe(true)
    }
    expect(consumeConsentMutationToken()).toBe(false)
    expect(consumeConsentMutationToken()).toBe(false)
  })

  it('emits exactly one warn when the consent-mutation cap is first crossed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 5; i++) {
      consumeConsentMutationToken()
    }
    // Multiple overflow attempts — one warn only.
    consumeConsentMutationToken()
    consumeConsentMutationToken()
    consumeConsentMutationToken()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('consent-mutation bucket resets across sessions, not within one', () => {
    for (let i = 0; i < 5; i++) {
      consumeConsentMutationToken()
    }
    expect(consumeConsentMutationToken()).toBe(false)
    resetBurstCapsForSession()
    expect(consumeConsentMutationToken()).toBe(true)
  })
})
