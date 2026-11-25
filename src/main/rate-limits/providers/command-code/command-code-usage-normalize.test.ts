import { describe, expect, it } from 'vitest'
import { normalizeCommandCodeUsage } from './command-code-usage-normalize'

const NOW = Date.UTC(2026, 10, 1)

describe('normalizeCommandCodeUsage', () => {
  it('maps used/limit to the monthly window and keeps the reset time in ms', () => {
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

  it('accepts second-based timestamps and wrapped payloads', () => {
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

  it('reports nothing for unrecognized shapes instead of guessing', () => {
    const result = normalizeCommandCodeUsage({
      credits: { message: 'ok' },
      subscriptions: { limit: 0, used: 3 },
      now: NOW
    })
    expect(result).toEqual({ monthly: null, extraUsage: null, planType: null })
  })

  it('reads a plan label when the subscription reports one', () => {
    const result = normalizeCommandCodeUsage({
      credits: null,
      subscriptions: { used: 1, limit: 10, plan: ' Pro ' },
      now: NOW
    })
    expect(result.planType).toBe('Pro')
  })

  it('drops a reset timestamp that already passed', () => {
    const result = normalizeCommandCodeUsage({
      credits: null,
      subscriptions: { used: 1, limit: 10, periodEnd: NOW - 10 * 86_400_000 },
      now: NOW
    })
    expect(result.monthly?.resetsAt).toBeNull()
  })
})
