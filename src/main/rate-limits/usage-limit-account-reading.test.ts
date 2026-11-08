import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { readUsageLimitAccountReading } from './usage-limit-account-reading'

const window = (usedPercent: number, resetsAt: number | null) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt,
  resetDescription: null
})

const limits = (overrides: Partial<ProviderRateLimits>): ProviderRateLimits => ({
  provider: 'claude',
  session: window(40, 2_000),
  weekly: window(40, 9_000),
  updatedAt: 1_000,
  error: null,
  status: 'ok',
  ...overrides
})

describe('readUsageLimitAccountReading', () => {
  it('waits for the latest reset among used-up windows', () => {
    expect(
      readUsageLimitAccountReading(
        limits({ session: window(100, 2_000), weekly: window(100, 9_000) })
      )
    ).toEqual({ checkedAt: 1_000, exhausted: true, resetsAt: 9_000 })
  })

  it('treats a used-up plan with spendable overage as having room', () => {
    expect(
      readUsageLimitAccountReading(
        limits({
          session: window(100, 2_000),
          extraUsage: {
            unit: 'currency',
            enabled: true,
            disabledReason: null,
            resetsAt: null,
            balance: null,
            currencyCode: 'USD',
            spent: 5,
            spendLimit: 50,
            spentPercent: 10
          }
        })
      )?.exhausted
    ).toBe(false)
  })

  it('gives no reading when the last fetch failed', () => {
    expect(readUsageLimitAccountReading(limits({ status: 'error', error: 'x' }))).toBeNull()
  })
})
