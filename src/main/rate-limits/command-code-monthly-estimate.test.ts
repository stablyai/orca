import { describe, expect, it } from 'vitest'
import { estimateCommandCodeMonthlyUsage } from './command-code-monthly-estimate'

const NOW = Date.parse('2026-09-15T12:00:00Z')
const data = {
  planId: 'individual-go',
  status: 'active',
  quantity: 1,
  orgId: null,
  currentPeriodStart: '2026-09-01T00:00:00Z',
  currentPeriodEnd: '2026-10-01T00:00:00Z'
}
const estimate = (overrides: Record<string, unknown>, remaining: unknown = 4) =>
  estimateCommandCodeMonthlyUsage(
    { success: true, data: { ...data, ...overrides } },
    remaining,
    NOW
  )

describe('Command Code monthly estimate', () => {
  it('uses the known allowance and real billing reset and marks the result estimated', () => {
    expect(estimate({})).toEqual({
      planType: 'Go',
      monthly: {
        usedPercent: 60,
        windowMinutes: 43200,
        resetsAt: Date.parse(data.currentPeriodEnd),
        resetDescription: null,
        estimated: true
      }
    })
  })

  it('distinguishes legacy Pro from the current Pro plan', () => {
    expect(estimate({ planId: 'individual-pro' }, 15).monthly?.usedPercent).toBe(50)
    expect(estimate({ planId: 'individual-pro-v1' }, 40).monthly?.usedPercent).toBe(50)
  })

  it.each([
    'individual-provider',
    'teams-pro',
    'enterprise',
    'individual-pro-v2',
    'individual-go-promo'
  ])('does not infer an allowance for %s', (planId) => {
    expect(estimate({ planId }).monthly).toBeNull()
  })

  it.each([
    { status: 'canceled' },
    { status: 'past_due' },
    { quantity: 2 },
    { orgId: 'test-org' },
    { currentPeriodEnd: '2027-09-01T00:00:00Z' },
    { currentPeriodEnd: '2026-09-10T00:00:00Z' },
    { currentPeriodStart: '2026-09-20T00:00:00Z' },
    { currentPeriodEnd: 'invalid' }
  ])('omits estimates for unsupported subscription terms', (overrides) => {
    expect(estimate(overrides).monthly).toBeNull()
  })

  it.each([-1, 11, Number.NaN, Infinity, '4', null])(
    'does not guess a cap for missing or inconsistent remaining credits',
    (remaining) => {
      expect(estimate({}, remaining).monthly).toBeNull()
    }
  )

  it('preserves depleted and unused allocations', () => {
    expect(estimate({}, 0).monthly?.usedPercent).toBe(100)
    expect(estimate({}, 10).monthly?.usedPercent).toBe(0)
  })
})
