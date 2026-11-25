import { describe, expect, it } from 'vitest'
import { normalizeCommandCodeUsage } from './command-code-usage-normalize'

const NOW = Date.UTC(2026, 10, 1)

// Live shapes from Command Code's billing routes (see command-code-usage-api.ts), with secrets/ids omitted.

function creditsShape(overrides?: {
  monthlyCredits?: number
  purchasedCredits?: number
  freeCredits?: number
  fiveHour?: unknown
  weekly?: unknown
}): unknown {
  return {
    credits: {
      belowThreshold: false,
      creditThreshold: 0,
      monthlyCredits: overrides?.monthlyCredits ?? 36.2593289986,
      purchasedCredits: overrides?.purchasedCredits ?? 20,
      freeCredits: overrides?.freeCredits ?? 0
    },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: overrides?.fiveHour ?? {
        used: 1.2484470936,
        cap: 14,
        exceeded: false,
        resetAt: NOW + 3_600_000
      },
      weekly: overrides?.weekly ?? {
        used: 33.7406710014,
        cap: 35,
        exceeded: false,
        resetAt: NOW + 86_400_000
      }
    },
    sandboxAccess: false,
    sandboxMinutes: 0
  }
}

describe('normalizeCommandCodeUsage', () => {
  it('maps windowLimits.fiveHour to the session window and windowLimits.weekly to the weekly window', () => {
    const result = normalizeCommandCodeUsage({
      credits: creditsShape(),
      subscriptions: null,
      now: NOW
    })
    expect(result.session).toEqual({
      usedPercent: (1.2484470936 / 14) * 100,
      windowMinutes: 5 * 60,
      resetsAt: NOW + 3_600_000,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: (33.7406710014 / 35) * 100,
      windowMinutes: 7 * 24 * 60,
      resetsAt: NOW + 86_400_000,
      resetDescription: null
    })
  })

  it('sums the three credit pools into the extra-usage balance', () => {
    const result = normalizeCommandCodeUsage({
      credits: creditsShape({ monthlyCredits: 10, purchasedCredits: 5, freeCredits: 2 }),
      subscriptions: null,
      now: NOW
    })
    expect(result.extraUsage).toMatchObject({ unit: 'credits', balance: 17 })
  })

  it('caps usedPercent at 100 when a window is over its cap', () => {
    const result = normalizeCommandCodeUsage({
      credits: creditsShape({
        fiveHour: { used: 20, cap: 14, exceeded: true, resetAt: NOW + 3_600_000 }
      }),
      subscriptions: null,
      now: NOW
    })
    expect(result.session?.usedPercent).toBe(100)
  })

  it('weekly without resetAt still yields a window with a null reset', () => {
    const result = normalizeCommandCodeUsage({
      credits: creditsShape({ weekly: { used: 3, cap: 10, exceeded: false } }),
      subscriptions: null,
      now: NOW
    })
    expect(result.weekly).toMatchObject({ usedPercent: 30, resetsAt: null })
  })

  it('reads the plan name from data.plan.name, falling back to status', () => {
    const byPlanName = normalizeCommandCodeUsage({
      credits: creditsShape(),
      subscriptions: { success: true, data: { status: 'active', plan: { name: 'Pro' } } },
      now: NOW
    })
    expect(byPlanName.planType).toBe('Pro')

    const byPlanNameField = normalizeCommandCodeUsage({
      credits: creditsShape(),
      subscriptions: { success: true, data: { status: 'active', planName: 'Plus' } },
      now: NOW
    })
    expect(byPlanNameField.planType).toBe('Plus')

    const byStatus = normalizeCommandCodeUsage({
      credits: creditsShape(),
      subscriptions: { success: true, data: { status: 'active' } },
      now: NOW
    })
    expect(byStatus.planType).toBe('active')
  })

  it('unrecognized shapes produce nulls, never a guessed meter', () => {
    const result = normalizeCommandCodeUsage({
      credits: { message: 'ok' },
      subscriptions: { message: 'ok' },
      now: NOW
    })
    expect(result).toEqual({ session: null, weekly: null, extraUsage: null, planType: null })
  })
})
