import { describe, expect, it } from 'vitest'
import type { AntigravityQuotaGroup } from './antigravity-cloud-code-api'
import {
  buildAntigravityBuckets,
  mostConstrainedWindow,
  toRateLimitBuckets
} from './antigravity-quota-buckets'

const WEEKLY_RESET = '2026-09-11T05:00:13Z'
const FIVE_HOUR_RESET = '2026-09-07T08:00:13Z'

function group(displayName: string, remaining: { weekly: number; fiveHour: number }) {
  return {
    displayName,
    buckets: [
      {
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        resetTime: WEEKLY_RESET,
        remainingFraction: remaining.weekly
      },
      {
        displayName: 'Five Hour Limit Remaining',
        window: '5h',
        resetTime: FIVE_HOUR_RESET,
        remainingFraction: remaining.fiveHour
      }
    ]
  } satisfies AntigravityQuotaGroup
}

describe('buildAntigravityBuckets', () => {
  it('maps the reported window rather than assuming one duration', () => {
    const [weekly, fiveHour] = buildAntigravityBuckets([
      group('Gemini Models', { weekly: 0.79675514, fiveHour: 0.94602 })
    ])
    expect(weekly).toMatchObject({
      name: 'Gemini Models (Weekly)',
      windowMinutes: 10080,
      usedPercent: 20,
      resetsAt: new Date(WEEKLY_RESET).getTime()
    })
    expect(fiveHour).toMatchObject({
      name: 'Gemini Models (5h)',
      windowMinutes: 300,
      usedPercent: 5
    })
  })

  it('keeps groups apart when their numbers are identical', () => {
    const buckets = buildAntigravityBuckets([
      group('Gemini Models', { weekly: 1, fiveHour: 1 }),
      group('Claude and GPT models', { weekly: 1, fiveHour: 1 })
    ])
    expect(buckets.map((b) => b.name)).toEqual([
      'Gemini Models (Weekly)',
      'Gemini Models (5h)',
      'Claude and GPT models (Weekly)',
      'Claude and GPT models (5h)'
    ])
  })

  it('drops windows it cannot express instead of guessing a duration', () => {
    const buckets = buildAntigravityBuckets([
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            displayName: 'Monthly',
            window: 'monthly',
            resetTime: WEEKLY_RESET,
            remainingFraction: 0.5
          }
        ]
      }
    ])
    expect(buckets).toEqual([])
  })

  it('clamps a reset time it cannot parse to null', () => {
    const [bucket] = buildAntigravityBuckets([
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: 'nope',
            remainingFraction: 0.5
          }
        ]
      }
    ])
    expect(bucket?.resetsAt).toBeNull()
  })
})

describe('mostConstrainedWindow', () => {
  const buckets = buildAntigravityBuckets([
    group('Gemini Models', { weekly: 0.2, fiveHour: 0.9 }),
    group('Claude and GPT models', { weekly: 0.95, fiveHour: 0.1 })
  ])

  it('reports the fullest group for each window', () => {
    expect(mostConstrainedWindow(buckets, 'weekly')).toMatchObject({
      usedPercent: 80,
      windowMinutes: 10080
    })
    expect(mostConstrainedWindow(buckets, '5h')).toMatchObject({
      usedPercent: 90,
      windowMinutes: 300
    })
  })

  it('returns null when the window is absent', () => {
    expect(mostConstrainedWindow(buckets, 'monthly')).toBeNull()
  })
})

describe('toRateLimitBuckets', () => {
  it('drops the internal window discriminator', () => {
    const [bucket] = toRateLimitBuckets(
      buildAntigravityBuckets([group('Gemini Models', { weekly: 1, fiveHour: 1 })])
    )
    expect(bucket && 'window' in bucket).toBe(false)
  })
})
