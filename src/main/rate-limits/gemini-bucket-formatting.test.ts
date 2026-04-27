import { describe, expect, it } from 'vitest'
import type { RateLimitBucket } from '../../shared/rate-limit-types'
import { getBucketName, deriveSessionSummary } from './gemini-bucket-formatting'

describe('getBucketName', () => {
  it('maps known model IDs to stable names', () => {
    expect(getBucketName('gemini-2.5-pro')).toBe('Pro')
    expect(getBucketName('gemini-2.5-flash')).toBe('Flash')
    expect(getBucketName('gemini-2.5-flash-lite')).toBe('Flash Lite')
    expect(getBucketName('gemini-2.0-flash-lite')).toBe('2.0 Flash Lite')
    expect(getBucketName('gemini-2.0-flash')).toBe('2.0 Flash')
  })

  it('humanizes unknown model IDs by stripping the gemini- prefix', () => {
    expect(getBucketName('gemini-3.0-ultra')).toBe('3.0 Ultra')
    expect(getBucketName('gemini-experimental')).toBe('Exp')
    expect(getBucketName('some-random-id')).toBe('Some Random Id')
  })
})

describe('deriveSessionSummary', () => {
  it('returns null for empty buckets', () => {
    expect(deriveSessionSummary([])).toBeNull()
  })

  it('picks the most constrained bucket (highest usedPercent) as session summary', () => {
    const buckets: RateLimitBucket[] = [
      { name: 'Pro', usedPercent: 30, windowMinutes: 60, resetsAt: null, resetDescription: null },
      { name: 'Flash', usedPercent: 80, windowMinutes: 60, resetsAt: null, resetDescription: null },
      {
        name: 'Flash Lite',
        usedPercent: 10,
        windowMinutes: 60,
        resetsAt: null,
        resetDescription: null
      }
    ]
    const summary = deriveSessionSummary(buckets)
    expect(summary).not.toBeNull()
    expect(summary!.usedPercent).toBe(80)
    expect(summary!.windowMinutes).toBe(60)
  })

  it('preserves reset metadata from the most constrained bucket', () => {
    const buckets: RateLimitBucket[] = [
      {
        name: 'Pro',
        usedPercent: 30,
        windowMinutes: 60,
        resetsAt: 1000,
        resetDescription: '2:00 PM'
      },
      {
        name: 'Flash',
        usedPercent: 80,
        windowMinutes: 60,
        resetsAt: 2000,
        resetDescription: '3:00 PM'
      }
    ]
    const summary = deriveSessionSummary(buckets)
    expect(summary!.resetsAt).toBe(2000)
    expect(summary!.resetDescription).toBe('3:00 PM')
  })
})
