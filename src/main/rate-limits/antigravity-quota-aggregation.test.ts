import { describe, expect, it } from 'vitest'
import {
  antigravityFamilyForGroup,
  antigravityWindowSlot,
  buildAntigravityRateLimitsFromQuota,
  populateAntigravity5hFromModelsIfMissing,
  populateAntigravitySlotsFromSummary,
  remainingToUsedPercent,
  upsertAntigravitySlot,
  antigravitySlotKey,
  type AntigravitySlotValue
} from './antigravity-quota-aggregation'

describe('antigravityFamilyForGroup', () => {
  it('classifies by displayName first', () => {
    expect(antigravityFamilyForGroup('Gemini models', 'claude-something')).toBe('gemini')
    expect(antigravityFamilyForGroup('Claude / third-party', 'x')).toBe('claude')
    expect(antigravityFamilyForGroup('GPT pool', 'x')).toBe('claude')
  })

  it('falls back to bucketId', () => {
    expect(antigravityFamilyForGroup('', 'gemini-flash')).toBe('gemini')
    expect(antigravityFamilyForGroup('', 'claude-sonnet')).toBe('claude')
    expect(antigravityFamilyForGroup('', '3p-other')).toBe('claude')
    expect(antigravityFamilyForGroup('', 'unknown')).toBeNull()
  })
})

describe('antigravityWindowSlot', () => {
  it('accepts 5h and weekly only', () => {
    expect(antigravityWindowSlot('5h')).toBe('5h')
    expect(antigravityWindowSlot('Weekly')).toBe('weekly')
    expect(antigravityWindowSlot('1h')).toBeNull()
  })
})

describe('remainingToUsedPercent', () => {
  it('maps remainingFraction to used percent', () => {
    expect(remainingToUsedPercent(1)).toBe(0)
    expect(remainingToUsedPercent(0.75)).toBe(25)
    expect(remainingToUsedPercent(0)).toBe(100)
  })
})

describe('populateAntigravitySlotsFromSummary', () => {
  it('builds four slots from summary groups', () => {
    const slots = new Map<string, AntigravitySlotValue>()
    populateAntigravitySlotsFromSummary(slots as never, {
      groups: [
        {
          displayName: 'Claude',
          buckets: [
            {
              bucketId: 'claude',
              window: '5h',
              remainingFraction: 0.68,
              resetTime: '2026-07-18T12:00:00Z'
            },
            {
              bucketId: 'claude',
              window: 'weekly',
              remainingFraction: 0.82,
              resetTime: '2026-07-20T00:00:00Z'
            }
          ]
        },
        {
          displayName: 'Gemini',
          buckets: [
            {
              bucketId: 'gemini',
              window: '5h',
              remainingFraction: 0.42,
              resetTime: '2026-07-18T13:00:00Z'
            },
            {
              bucketId: 'gemini',
              window: 'weekly',
              remainingFraction: null,
              resetTime: '2026-07-21T00:00:00Z'
            }
          ]
        }
      ]
    })

    const limits = buildAntigravityRateLimitsFromQuota({
      summary: {
        groups: [
          {
            displayName: 'Claude',
            buckets: [
              {
                bucketId: 'claude',
                window: '5h',
                remainingFraction: 0.68,
                resetTime: '2026-07-18T12:00:00Z'
              },
              {
                bucketId: 'claude',
                window: 'weekly',
                remainingFraction: 0.82,
                resetTime: '2026-07-20T00:00:00Z'
              }
            ]
          },
          {
            displayName: 'Gemini',
            buckets: [
              {
                bucketId: 'gemini',
                window: '5h',
                remainingFraction: 0.42,
                resetTime: '2026-07-18T13:00:00Z'
              },
              {
                bucketId: 'gemini',
                window: 'weekly',
                remainingFraction: null,
                resetTime: '2026-07-21T00:00:00Z'
              }
            ]
          }
        ]
      },
      models: null,
      updatedAt: 1
    })

    expect(limits.status).toBe('ok')
    expect(limits.buckets?.map((b) => b.name)).toEqual(['Claude', 'Claude W', 'Gemini'])
    expect(limits.buckets?.find((b) => b.name === 'Claude')?.usedPercent).toBe(32)
    expect(limits.buckets?.find((b) => b.name === 'Gemini')?.usedPercent).toBe(58)
    expect(limits.buckets?.find((b) => b.name === 'Gemini W')).toBeUndefined()
    // Session is the more constrained 5h window (Gemini 58% > Claude 32%).
    expect(limits.session?.usedPercent).toBe(58)
    expect(limits.weekly?.usedPercent).toBe(18)
  })

  it('keeps the tighter remaining for duplicate family/window', () => {
    const slots = new Map()
    upsertAntigravitySlot(slots, 'claude', '5h', 0.5, 'a')
    upsertAntigravitySlot(slots, 'claude', '5h', 0.2, 'b')
    expect(slots.get(antigravitySlotKey('claude', '5h'))).toEqual({ remaining: 0.2, reset: 'b' })
  })
})

describe('populateAntigravity5hFromModelsIfMissing', () => {
  it('fills missing 5h slots from fetchAvailableModels', () => {
    const slots = new Map()
    populateAntigravity5hFromModelsIfMissing(slots, {
      models: {
        'claude-sonnet-4': {
          quotaInfo: { remainingFraction: 0.9, resetTime: '2026-07-18T10:00:00Z' }
        },
        'gemini-2.5-pro': {
          quotaInfo: { remainingFraction: 0.5, resetTime: '2026-07-18T11:00:00Z' }
        },
        'gemini-2.5-flash': {
          quotaInfo: { remainingFraction: 0.3, resetTime: '2026-07-18T11:30:00Z' }
        }
      }
    })
    expect(slots.get(antigravitySlotKey('claude', '5h'))?.remaining).toBe(0.9)
    // Most constrained gemini model wins.
    expect(slots.get(antigravitySlotKey('gemini', '5h'))?.remaining).toBe(0.3)
  })

  it('does not override summary 5h', () => {
    const slots = new Map()
    upsertAntigravitySlot(slots, 'claude', '5h', 0.8, 'summary')
    populateAntigravity5hFromModelsIfMissing(slots, {
      models: {
        'claude-opus': { quotaInfo: { remainingFraction: 0.1, resetTime: 'models' } }
      }
    })
    expect(slots.get(antigravitySlotKey('claude', '5h'))?.remaining).toBe(0.8)
  })
  it('skips metadata-only models instead of reporting exhausted quota', () => {
    const slots = new Map()
    populateAntigravity5hFromModelsIfMissing(slots, {
      models: {
        'claude-sonnet': {},
        'gemini-pro': { quotaInfo: { remainingFraction: null } }
      }
    })
    expect(slots.size).toBe(0)
  })
})
