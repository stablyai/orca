import { describe, expect, it } from 'vitest'
import { estimateSyntheticQuotaRechargeAt } from './synthetic-quota-recharge'

const quota = { usedPercent: 20, nextRefillAt: 900_000, refillPercent: 5, intervalMs: 900_000 }

describe('Synthetic full recharge estimates', () => {
  it.each([
    { refillPercent: 5, expected: 3_600_000 },
    { refillPercent: 10, expected: 1_800_000 },
    { refillPercent: 25, expected: 900_000 }
  ])('uses the plan refill amount: $refillPercent%', ({ refillPercent, expected }) => {
    expect(estimateSyntheticQuotaRechargeAt({ ...quota, refillPercent })).toBe(expected)
  })
  it('rounds up partial refill steps', () => {
    expect(estimateSyntheticQuotaRechargeAt({ ...quota, usedPercent: 20.1 })).toBe(4_500_000)
  })
  it('does not add a tick for floating-point noise', () => {
    expect(estimateSyntheticQuotaRechargeAt({ ...quota, usedPercent: 20.00000000001 })).toBe(
      3_600_000
    )
  })
  it.each([
    { refillPercent: null },
    { refillPercent: 0 },
    { refillPercent: Number.NaN },
    { intervalMs: null },
    { intervalMs: -1 },
    { nextRefillAt: null },
    { usedPercent: 0 }
  ])('omits estimates without a valid refill schedule: %j', (missing) => {
    expect(estimateSyntheticQuotaRechargeAt({ ...quota, ...missing })).toBeNull()
  })
})
