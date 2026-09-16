import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

const summary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          resetTime: '2099-01-10T18:00:00Z',
          remainingFraction: 0.197
        },
        {
          bucketId: 'gemini-5h',
          window: '5h',
          resetTime: '2099-01-08T14:00:00Z',
          remainingFraction: 0.83
        }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        {
          bucketId: '3p-weekly',
          window: 'weekly',
          resetTime: '2099-01-11T12:00:00Z',
          remainingFraction: 1
        },
        {
          bucketId: '3p-5h',
          window: '5h',
          remainingFraction: 0.4
        }
      ]
    }
  ]
}

describe('parseAntigravityQuotaSummary', () => {
  it('maps group windows onto session, weekly, and named buckets', () => {
    const parsed = parseAntigravityQuotaSummary(summary)
    expect(parsed?.buckets.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
      ['Gemini Models · Weekly', 80],
      ['Gemini Models · Five hour', 17],
      ['Claude and GPT models · Weekly', 0],
      ['Claude and GPT models · Five hour', 60]
    ])
    expect(parsed?.session?.usedPercent).toBe(60)
    expect(parsed?.weekly?.usedPercent).toBe(80)
    expect(parsed?.session?.windowMinutes).toBe(300)
    expect(parsed?.weekly?.windowMinutes).toBe(10080)
  })

  it('reads a wrapped response.groups payload', () => {
    const parsed = parseAntigravityQuotaSummary({ response: summary })
    expect(parsed?.weekly?.usedPercent).toBe(80)
  })

  it('returns null when no remainingFraction buckets are present', () => {
    expect(
      parseAntigravityQuotaSummary({ groups: [{ displayName: 'Gemini Models', buckets: [] }] })
    ).toBe(null)
  })
})
