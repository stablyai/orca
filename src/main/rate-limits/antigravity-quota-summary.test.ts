import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

/**
 * Shape of `RetrieveUserQuotaSummaryResponse` as Antigravity LanguageServer 1.1.21 returns it.
 */
function summaryResponse() {
  return {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Gemini model family',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit',
              window: 'FIVE_HOURS',
              remainingFraction: 0.75,
              disabled: false,
              resetTime: '2026-08-26T23:04:43Z'
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit',
              window: 'WEEKLY',
              remainingFraction: 0.97,
              disabled: false,
              resetTime: '2026-09-02T18:04:43Z'
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              displayName: 'Five Hour Limit',
              window: 'FIVE_HOURS',
              remainingFraction: 0.4,
              disabled: false,
              resetTime: '2026-08-26T23:04:43Z'
            },
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly Limit',
              window: 'WEEKLY',
              remainingFraction: 1,
              disabled: false,
              resetTime: '2026-09-02T18:04:43Z'
            }
          ]
        }
      ]
    }
  }
}

describe('parseAntigravityQuotaSummary', () => {
  // Why: the two pools bill separately and reset independently — collapsing them to one number
  // is the reporting error #9122 is about.
  it('keeps both quota pools as separately named buckets', () => {
    const summary = parseAntigravityQuotaSummary(summaryResponse())

    expect(summary?.buckets.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · 7d',
      'Claude and GPT models · 5h',
      'Claude and GPT models · 7d'
    ])
  })

  it('converts the remaining fraction into a used percentage', () => {
    const summary = parseAntigravityQuotaSummary(summaryResponse())

    expect(summary?.buckets[0]?.usedPercent).toBe(25)
    expect(summary?.buckets[1]?.usedPercent).toBe(3)
  })

  it('preserves each pool independent reset time', () => {
    const summary = parseAntigravityQuotaSummary(summaryResponse())

    expect(summary?.buckets[0]?.resetsAt).toBe(Date.parse('2026-08-26T23:04:43Z'))
    expect(summary?.buckets[1]?.resetsAt).toBe(Date.parse('2026-09-02T18:04:43Z'))
  })

  // Why: the compact status bar shows one number, and the pool that stops the user first is
  // the only honest choice — Claude/GPT at 60% used beats Gemini at 25%.
  it('summarises each window with its most constrained pool', () => {
    const summary = parseAntigravityQuotaSummary(summaryResponse())

    expect(summary?.session?.usedPercent).toBe(60)
    expect(summary?.session?.windowMinutes).toBe(300)
    expect(summary?.weekly?.usedPercent).toBe(3)
    expect(summary?.weekly?.windowMinutes).toBe(10080)
  })

  it('skips a disabled bucket', () => {
    const response = summaryResponse()
    response.response.groups[1]!.buckets[0]!.disabled = true

    const summary = parseAntigravityQuotaSummary(response)

    expect(summary?.buckets.map((bucket) => bucket.name)).not.toContain(
      'Claude and GPT models · 5h'
    )
    // Why: with the tightest 5h pool disabled the summary must fall back, not report 60%.
    expect(summary?.session?.usedPercent).toBe(25)
  })

  it('keeps compatibility with top-level buckets and snake_case field names', () => {
    const summary = parseAntigravityQuotaSummary({
      buckets: [
        {
          display_name: 'Gemini Models',
          buckets: [
            {
              bucket_id: 'gemini-5h',
              remaining_fraction: 0.5,
              reset_time: '2026-08-26T23:04:43Z'
            }
          ]
        }
      ]
    })

    expect(summary?.buckets[0]).toMatchObject({ name: 'Gemini Models · 5h', usedPercent: 50 })
  })

  it('tolerates a missing reset time', () => {
    const summary = parseAntigravityQuotaSummary({
      buckets: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 1 }] }
      ]
    })

    expect(summary?.buckets[0]?.resetsAt).toBeNull()
  })

  it('returns null when no bucket can be read', () => {
    expect(parseAntigravityQuotaSummary({ buckets: [] })).toBeNull()
    expect(
      parseAntigravityQuotaSummary({ buckets: [{ displayName: 'x', buckets: [] }] })
    ).toBeNull()
    expect(parseAntigravityQuotaSummary({})).toBeNull()
    expect(parseAntigravityQuotaSummary(null)).toBeNull()
  })

  // Why: an unrecognised window would otherwise be silently filed as a five-hour bucket.
  it('drops a bucket whose window cannot be classified', () => {
    expect(
      parseAntigravityQuotaSummary({
        buckets: [
          {
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'monthly-ish', remainingFraction: 1 }]
          }
        ]
      })
    ).toBeNull()
  })
})
