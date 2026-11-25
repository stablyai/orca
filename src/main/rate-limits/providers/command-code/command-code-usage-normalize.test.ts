import { describe, expect, it } from 'vitest'
import { normalizeCommandCodeUsage } from './command-code-usage-normalize'

const NOW = Date.UTC(2026, 10, 1)

// ASSUMED SHAPES: Command Code's billing routes are undocumented (see command-code-usage-api.ts).
// These fixtures encode guesses about field names and units; they prove the normalizer's
// arithmetic and fallbacks, not that the live API returns these shapes.

describe('normalizeCommandCodeUsage (assumed response shapes)', () => {
  it('assumed {used, limit, periodEnd}: maps to the monthly window with ms reset', () => {
    const result = normalizeCommandCodeUsage({
      credits: null,
      subscriptions: { used: 25, limit: 100, periodEnd: NOW + 86_400_000 },
      now: NOW
    })
    expect(result.monthly).toEqual({
      usedPercent: 25,
      windowMinutes: 30 * 24 * 60,
      resetsAt: NOW + 86_400_000,
      resetDescription: null
    })
  })

  it('assumed {data: ...} wrapper and second-based reset: accepted', () => {
    const resetSeconds = Math.floor((NOW + 3_600_000) / 1000)
    const result = normalizeCommandCodeUsage({
      credits: { data: { balance: 4.5 } },
      subscriptions: { data: { usage: 150, quota: 100, resetAt: resetSeconds } },
      now: NOW
    })
    expect(result.monthly?.usedPercent).toBe(100)
    expect(result.monthly?.resetsAt).toBe(resetSeconds * 1000)
    expect(result.extraUsage).toMatchObject({ unit: 'credits', balance: 4.5 })
  })

  it('unrecognized shapes produce nulls, never a guessed meter', () => {
    const result = normalizeCommandCodeUsage({
      credits: { message: 'ok' },
      subscriptions: { limit: 0, used: 3 },
      now: NOW
    })
    expect(result).toEqual({ monthly: null, extraUsage: null, planType: null })
  })

  it('assumed plan string field: trimmed and surfaced', () => {
    const result = normalizeCommandCodeUsage({
      credits: null,
      subscriptions: { used: 1, limit: 10, plan: ' Pro ' },
      now: NOW
    })
    expect(result.planType).toBe('Pro')
  })

  it('assumed reset in the past: dropped rather than shown as current', () => {
    const result = normalizeCommandCodeUsage({
      credits: null,
      subscriptions: { used: 1, limit: 10, periodEnd: NOW - 10 * 86_400_000 },
      now: NOW
    })
    expect(result.monthly?.resetsAt).toBeNull()
  })
})
