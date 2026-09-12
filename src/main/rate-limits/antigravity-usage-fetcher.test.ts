import { describe, expect, it } from 'vitest'
import { quotaRateLimitsFromResponse } from './antigravity-usage-fetcher'

// Captured from RetrieveUserQuotaSummary on a Google AI Pro account.
const BODY = JSON.stringify({
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.20240954,
            resetTime: '2026-09-10T18:26:27Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 0.7737272,
            resetTime: '2026-09-07T23:07:06Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1 }
        ]
      }
    ]
  }
})

describe('quotaRateLimitsFromResponse', () => {
  it('names a bucket per pool and window', () => {
    expect(quotaRateLimitsFromResponse(200, BODY).buckets).toEqual([
      {
        name: 'Gemini Weekly',
        usedPercent: 80,
        windowMinutes: 10080,
        resetsAt: Date.parse('2026-09-10T18:26:27Z'),
        resetDescription: null
      },
      {
        name: 'Gemini 5h',
        usedPercent: 23,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-09-07T23:07:06Z'),
        resetDescription: null
      },
      {
        name: 'Claude and GPT Weekly',
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      {
        name: 'Claude and GPT 5h',
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ])
  })

  it('summarises each window with its most constrained pool', () => {
    const limits = quotaRateLimitsFromResponse(200, BODY)
    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
    expect(limits.session).toMatchObject({ usedPercent: 23, windowMinutes: 300 })
    expect(limits.weekly).toMatchObject({ usedPercent: 80, windowMinutes: 10080 })
  })

  it.each([
    ['a drifted endpoint', 404, BODY],
    ['a server error', 500, ''],
    ['malformed JSON', 200, '{'],
    ['no groups', 200, '{"response":{}}'],
    [
      'only unknown windows',
      200,
      '{"response":{"groups":[{"buckets":[{"window":"daily","remainingFraction":0.5}]}]}}'
    ]
  ])('reports %s as an unreadable error', (_case, statusCode, body) => {
    const limits = quotaRateLimitsFromResponse(statusCode, body)
    expect(limits.status).toBe('error')
    expect(limits.error).toContain('without any readable quota')
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
  })
})
