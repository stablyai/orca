import { describe, expect, it } from 'vitest'
import { mapKimiUsageResponse } from './kimi-usage-mapping'

describe('mapKimiUsageResponse', () => {
  it('maps a monthly limits entry into monthly instead of weekly or dropping it', () => {
    const result = mapKimiUsageResponse({
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '12', resetTime: '2026-11-19T18:00:00.000Z' }
        },
        {
          window: { duration: 1, timeUnit: 'TIME_UNIT_MONTH' },
          detail: { limit: '2000', used: '500', resetTime: '2026-12-01T00:00:00.000Z' }
        }
      ]
    })

    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.session).toMatchObject({
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: 1795111200000
    })
    expect(result.monthly).toMatchObject({
      usedPercent: 25,
      windowMinutes: 43200,
      resetsAt: 1796083200000
    })
  })

  it('maps a 30-day limits entry into monthly rather than weekly', () => {
    const result = mapKimiUsageResponse({
      limits: [
        {
          window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
          detail: { limit: 100, remaining: 80, resetTime: '2026-11-19T18:00:00.000Z' }
        },
        {
          window: { duration: 30, timeUnit: 'TIME_UNIT_DAY' },
          detail: { limit: 1000, used: 400, resetTime: '2026-12-19T00:00:00.000Z' }
        }
      ]
    })

    expect(result.weekly).toBeNull()
    expect(result.session?.usedPercent).toBe(20)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.monthly).toMatchObject({
      usedPercent: 40,
      windowMinutes: 43200,
      resetsAt: 1797638400000
    })
  })

  it('reads limit_month_total from usages when limits only carries the 5h window', () => {
    const result = mapKimiUsageResponse({
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '0', resetTime: '2026-11-19T18:00:00.000Z' }
        }
      ],
      usages: {
        limit_5h: { used_ratio: 0, reset_time: '2026-11-19T18:00:00Z' },
        limit_month_total: { used_ratio: 0.375, reset_time: '2026-12-01T00:00:00Z' }
      }
    })

    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.session?.usedPercent).toBe(0)
    expect(result.monthly).toMatchObject({
      usedPercent: 37.5,
      windowMinutes: 43200,
      resetsAt: 1796083200000
    })
  })

  it('keeps legacy top-level usage without a window descriptor as weekly', () => {
    const result = mapKimiUsageResponse({
      usage: { limit: '100', used: '45', resetTime: '2026-11-26T00:00:00.000Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '10', resetTime: '2026-11-19T18:00:00.000Z' }
        }
      ]
    })

    expect(result.weekly).toMatchObject({
      usedPercent: 45,
      windowMinutes: 10080,
      resetsAt: 1795651200000
    })
    expect(result.monthly).toBeUndefined()
  })

  it('does not spill a duplicate monthly top-level usage into weekly', () => {
    const result = mapKimiUsageResponse({
      usage: {
        limit: '2000',
        used: '600',
        resetTime: '2026-12-01T00:00:00.000Z',
        window: { duration: 1, timeUnit: 'TIME_UNIT_MONTH' }
      },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', used: '10', resetTime: '2026-11-19T18:00:00.000Z' }
        },
        {
          window: { duration: 1, timeUnit: 'TIME_UNIT_MONTH' },
          detail: { limit: '2000', used: '500', resetTime: '2026-12-01T00:00:00.000Z' }
        }
      ]
    })

    expect(result.weekly).toBeNull()
    expect(result.monthly?.usedPercent).toBe(25)
    expect(result.session?.usedPercent).toBe(10)
  })

  it('does not spill a duplicate weekly top-level usage into session or block limit_5h fallback', () => {
    const result = mapKimiUsageResponse({
      usage: {
        limit: '100',
        used: '50',
        resetTime: '2026-11-26T00:00:00.000Z',
        window: { duration: 1, timeUnit: 'TIME_UNIT_WEEK' }
      },
      limits: [
        {
          window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' },
          detail: { limit: '100', used: '40', resetTime: '2026-11-26T00:00:00.000Z' }
        }
      ],
      usages: {
        limit_5h: { used_ratio: 0.15, reset_time: '2026-11-19T18:00:00Z' }
      }
    })

    expect(result.weekly?.usedPercent).toBe(40)
    expect(result.session).toMatchObject({
      usedPercent: 15,
      windowMinutes: 300,
      resetsAt: 1795111200000
    })
  })
})
