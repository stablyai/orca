import { describe, expect, it } from 'vitest'
import { parseAntigravityGeminiQuota } from './antigravity-usage-fetcher'

describe('parseAntigravityGeminiQuota', () => {
  it('maps only the Gemini five-hour and weekly buckets', () => {
    const result = parseAntigravityGeminiQuota({
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                window: 'weekly',
                remainingFraction: 0.72,
                resetTime: '2026-08-03T03:13:16Z'
              },
              {
                window: '5h',
                remainingFraction: 0.91,
                resetTime: '2026-07-30T06:05:28Z'
              }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                window: 'weekly',
                remainingFraction: 0.1,
                resetTime: '2026-08-06T01:06:50Z'
              }
            ]
          }
        ]
      }
    })

    expect(result).toEqual({
      session: {
        usedPercent: 9,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-07-30T06:05:28Z'),
        resetDescription: null
      },
      weekly: {
        usedPercent: 28,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-08-03T03:13:16Z'),
        resetDescription: null
      }
    })
  })

  it('returns null when the Gemini quota group is missing', () => {
    expect(
      parseAntigravityGeminiQuota({
        response: { groups: [{ displayName: 'Claude and GPT models', buckets: [] }] }
      })
    ).toBeNull()
  })
})
