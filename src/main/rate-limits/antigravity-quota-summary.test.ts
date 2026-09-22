import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

describe('parseAntigravityQuotaSummary', () => {
  it('maps grouped five-hour and weekly buckets', () => {
    const parsed = parseAntigravityQuotaSummary({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: '5h',
              remainingFraction: 0.4,
              resetTime: '2026-09-21T18:00:00.000Z'
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.75,
              resetTime: '2026-09-28T00:00:00.000Z'
            }
          ]
        }
      ]
    })
    expect(parsed?.session?.usedPercent).toBe(60)
    expect(parsed?.weekly?.usedPercent).toBe(25)
    expect(parsed?.buckets).toHaveLength(2)
  })

  it('reads Connect-RPC wrapped responses', () => {
    const parsed = parseAntigravityQuotaSummary({
      response: {
        groups: [
          {
            displayName: 'Antigravity',
            buckets: [{ bucketId: 'five-hour', remaining_fraction: 0.1 }]
          }
        ]
      }
    })
    expect(parsed?.session?.usedPercent).toBe(90)
  })

  it('returns null when no usable buckets are present', () => {
    expect(parseAntigravityQuotaSummary({})).toBeNull()
    expect(parseAntigravityQuotaSummary({ groups: [{ buckets: [{ disabled: true }] }] })).toBeNull()
  })
})
