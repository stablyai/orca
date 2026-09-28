import { describe, expect, it } from 'vitest'
import { kiroUsageToProviderRateLimits } from './kiro-usage-to-rate-limits'
import type { KiroUsageSnapshot } from '../../shared/kiro-usage-types'

const okSnapshot: KiroUsageSnapshot = {
  status: 'ok',
  error: null,
  updatedAt: 123,
  quota: { used: 132.35, limit: 1000, usedPercent: 13.2, resetsOn: '2026-10-01', plan: 'KIRO PRO' }
}

describe('kiroUsageToProviderRateLimits', () => {
  it('maps an ok quota to a monthly window with plan and credits', () => {
    const p = kiroUsageToProviderRateLimits(okSnapshot)
    expect(p.provider).toBe('kiro')
    expect(p.status).toBe('ok')
    expect(p.session).toBeNull()
    expect(p.weekly).toBeNull()
    expect(p.monthly).toEqual({
      usedPercent: 13.2,
      windowMinutes: 43200,
      resetsAt: Date.parse('2026-10-01T00:00:00'),
      resetDescription: '2026-10-01'
    })
    expect(p.planType).toBe('KIRO PRO')
    expect(p.kiroCredits).toEqual({ used: 132.35, limit: 1000 })
    expect(p.updatedAt).toBe(123)
  })

  it('handles a missing reset date as null resetsAt', () => {
    const p = kiroUsageToProviderRateLimits({
      ...okSnapshot,
      quota: { ...okSnapshot.quota!, resetsOn: null }
    })
    expect(p.monthly?.resetsAt).toBeNull()
    expect(p.monthly?.resetDescription).toBeNull()
  })

  it('maps unavailable and error snapshots to a null monthly window', () => {
    const unavailable = kiroUsageToProviderRateLimits({
      status: 'unavailable',
      quota: null,
      error: null,
      updatedAt: 1
    })
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.monthly).toBeNull()

    const errored = kiroUsageToProviderRateLimits({
      status: 'error',
      quota: null,
      error: 'boom',
      updatedAt: 1
    })
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('boom')
    expect(errored.monthly).toBeNull()
  })
})
