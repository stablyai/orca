import { describe, expect, it } from 'vitest'
import { mapKimchiUserBudget } from './kimchi-usage-mapping'

const period = {
  startTime: '2026-11-01T00:00:00Z',
  endTime: '2026-12-01T00:00:00Z'
}

describe('mapKimchiUserBudget', () => {
  it('uses the closest applicable capped budget and its UTC monthly reset', () => {
    const mapped = mapKimchiUserBudget({
      period,
      budgets: [
        { scope: 'USER', budgetLimitUsd: '80.00', totalSpendUsd: '60.00' },
        { scope: 'API_KEY', budgetLimitUsd: '40.00', totalSpendUsd: '38.00' },
        { scope: 'ORGANIZATION_SOFT', budgetLimitUsd: '0', totalSpendUsd: '500' }
      ]
    })

    expect(mapped).toEqual({
      kind: 'ok',
      planType: 'api_key',
      monthly: {
        usedPercent: 95,
        windowMinutes: 43_200,
        resetsAt: Date.parse(period.endTime),
        resetDescription: null
      }
    })
  })

  it('matches Kimchi footer selection when an organization soft budget has highest usage', () => {
    expect(
      mapKimchiUserBudget({
        period,
        budgets: [
          { scope: 'USER', budgetLimitUsd: '100', totalSpendUsd: '10' },
          { scope: 'ORGANIZATION_SOFT', budgetLimitUsd: '100', totalSpendUsd: '150' }
        ]
      })
    ).toMatchObject({
      kind: 'ok',
      planType: 'organization_soft',
      monthly: { usedPercent: 100 }
    })
  })

  it('does not invent a quota when every applicable budget is unlimited', () => {
    expect(
      mapKimchiUserBudget({
        period,
        budgets: [{ scope: 'USER', budgetLimitUsd: '0', totalSpendUsd: '25' }]
      })
    ).toEqual({ kind: 'unavailable' })
  })

  it('clamps consumption and tolerates an unknown reset without emitting NaN', () => {
    expect(
      mapKimchiUserBudget({
        period: { endTime: 'not-a-date' },
        budgets: [{ scope: 'USER', budgetLimitUsd: '100', totalSpendUsd: '150' }]
      })
    ).toMatchObject({
      kind: 'ok',
      monthly: { usedPercent: 100, windowMinutes: 43_200, resetsAt: null }
    })
    expect(
      mapKimchiUserBudget({
        budgets: [{ scope: 'USER', budgetLimitUsd: '100', totalSpendUsd: '-5' }]
      })
    ).toMatchObject({ kind: 'ok', monthly: { usedPercent: 0 } })
  })

  it('rejects malformed monetary values instead of displaying a false total', () => {
    expect(
      mapKimchiUserBudget({
        budgets: [{ scope: 'USER', budgetLimitUsd: 'not-money', totalSpendUsd: '1' }]
      })
    ).toEqual({ kind: 'parse' })
  })
})
