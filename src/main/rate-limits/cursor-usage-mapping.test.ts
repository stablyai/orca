import { describe, expect, it } from 'vitest'
import { mapCursorLegacyRequestQuota, mapCursorUsageSummary } from './cursor-usage-mapping'

const CYCLE = {
  billingCycleStart: '2026-09-01T00:00:00.000Z',
  billingCycleEnd: '2026-10-01T00:00:00.000Z'
}

describe('mapCursorUsageSummary', () => {
  it('maps both plan pools Cursor bills individual accounts from', () => {
    const mapped = mapCursorUsageSummary({
      ...CYCLE,
      membershipType: 'pro',
      individualUsage: {
        plan: { enabled: true, used: 1_250, limit: 5_000, autoPercentUsed: 40, apiPercentUsed: 10 }
      }
    })
    expect(mapped.planType).toBe('pro')
    expect(mapped.buckets.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
      ['Cursor Models', 40],
      ['Other Models', 10]
    ])
    expect(mapped.monthly?.usedPercent).toBe(25)
    expect(mapped.monthly?.resetsAt).toBe(Date.parse(CYCLE.billingCycleEnd))
  })

  it('prefers the used/limit pair over the rounded percentage Cursor renders', () => {
    const mapped = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: { plan: { enabled: true, used: 1_000, limit: 3_000, totalPercentUsed: 33 } }
    })
    expect(mapped.monthly?.usedPercent).toBeCloseTo(33.333, 3)
  })

  it('falls back to the percentage when no cents allowance is reported', () => {
    const mapped = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: { plan: { enabled: true, totalPercentUsed: 62 } }
    })
    expect(mapped.monthly?.usedPercent).toBe(62)
  })

  it('adds an on-demand bucket only once the user has enabled on-demand spend', () => {
    const disabled = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: {
        plan: { enabled: true, totalPercentUsed: 5 },
        onDemand: { used: 900, limit: 1_000 }
      }
    })
    expect(disabled.buckets).toHaveLength(0)

    const enabled = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: {
        plan: { enabled: true, totalPercentUsed: 5 },
        onDemand: { enabled: true, used: 900, limit: 1_000 }
      }
    })
    expect(enabled.buckets).toEqual([
      expect.objectContaining({ name: 'On-demand', usedPercent: 90 })
    ])
  })

  it('clamps an over-consumed pool to 100% instead of overflowing the bar', () => {
    const mapped = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: { plan: { enabled: true, used: 7_000, limit: 5_000 } }
    })
    expect(mapped.monthly?.usedPercent).toBe(100)
  })

  it('publishes no pools for a plan the account does not own', () => {
    // Why: a team-billed account still reports 0% pools. Publishing them would
    // paint a healthy 0% meter and skip the request-quota fallback.
    const mapped = mapCursorUsageSummary({
      ...CYCLE,
      individualUsage: {
        plan: { enabled: false, autoPercentUsed: 0, apiPercentUsed: 0, totalPercentUsed: 0 }
      }
    })
    expect(mapped.buckets).toHaveLength(0)
    expect(mapped.monthly).toBeNull()
  })

  it('reports an unlimited plan without inventing a percentage', () => {
    const mapped = mapCursorUsageSummary({ ...CYCLE, isUnlimited: true, membershipType: 'ultra' })
    expect(mapped.isUnlimited).toBe(true)
    expect(mapped.monthly).toBeNull()
    expect(mapped.buckets).toHaveLength(0)
  })

  it('accepts epoch seconds and milliseconds for the billing cycle', () => {
    const seconds = mapCursorUsageSummary({
      billingCycleEnd: 1_790_000_000,
      individualUsage: { plan: { enabled: true, totalPercentUsed: 1 } }
    })
    const millis = mapCursorUsageSummary({
      billingCycleEnd: 1_790_000_000_000,
      individualUsage: { plan: { enabled: true, totalPercentUsed: 1 } }
    })
    expect(seconds.monthly?.resetsAt).toBe(1_790_000_000_000)
    expect(millis.monthly?.resetsAt).toBe(1_790_000_000_000)
  })

  it('returns nothing to publish for an empty payload', () => {
    const mapped = mapCursorUsageSummary({})
    expect(mapped.monthly).toBeNull()
    expect(mapped.buckets).toHaveLength(0)
    expect(mapped.planType).toBeNull()
  })

  it('derives the window from the reported cycle rather than assuming 30 days', () => {
    const mapped = mapCursorUsageSummary({
      billingCycleStart: '2026-09-01T00:00:00.000Z',
      billingCycleEnd: '2026-09-08T00:00:00.000Z',
      individualUsage: { plan: { enabled: true, totalPercentUsed: 10 } }
    })
    expect(mapped.monthly?.windowMinutes).toBe(7 * 24 * 60)
  })
})

describe('mapCursorLegacyRequestQuota', () => {
  it('uses the premium gpt-4 bucket on request-quota plans', () => {
    const window = mapCursorLegacyRequestQuota({
      'gpt-4': { numRequests: 250, maxRequestUsage: 500 },
      'gpt-3.5-turbo': { numRequests: 10, maxRequestUsage: 9_999 },
      startOfMonth: '2026-09-01T00:00:00.000Z'
    })
    expect(window?.usedPercent).toBe(50)
    expect(window?.resetsAt).toBe(new Date('2026-10-01T00:00:00.000Z').getTime())
  })

  it('falls back to the largest ceiling when no gpt-4 bucket is present', () => {
    const window = mapCursorLegacyRequestQuota({
      small: { numRequests: 1, maxRequestUsage: 10 },
      large: { numRequests: 20, maxRequestUsage: 100 }
    })
    expect(window?.usedPercent).toBe(20)
  })

  it('clamps a month-end cycle start instead of overflowing into the next month', () => {
    const window = mapCursorLegacyRequestQuota({
      'gpt-4': { numRequests: 1, maxRequestUsage: 10 },
      startOfMonth: '2026-01-31T00:00:00.000Z'
    })
    expect(window?.resetsAt).toBe(Date.parse('2026-02-28T00:00:00.000Z'))
  })

  it('ignores unmetered buckets and returns null when nothing is metered', () => {
    expect(
      mapCursorLegacyRequestQuota({ free: { numRequests: 3, maxRequestUsage: null } })
    ).toBeNull()
    expect(mapCursorLegacyRequestQuota(null)).toBeNull()
  })
})
