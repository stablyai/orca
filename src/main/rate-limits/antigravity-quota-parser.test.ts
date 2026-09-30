import { describe, expect, it } from 'vitest'
import { buildAntigravityRateLimits, parseAntigravityQuotaRows } from './antigravity-quota-parser'

// Why: captured verbatim from `agy -p /quota` (Antigravity CLI 1.2.0, macOS).
const CAPTURED_QUOTA_OUTPUT = [
  'Gemini Models\tWeekly Limit Remaining\t98%\t2026-09-23T09:08:07Z',
  'Gemini Models\tFive Hour Limit Remaining\t87%\t2026-09-16T14:08:07Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-23T10:37:31Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-16T15:37:31Z'
].join('\n')

describe('parseAntigravityQuotaRows', () => {
  it('parses every row into an inverted used-percent window', () => {
    const rows = parseAntigravityQuotaRows(CAPTURED_QUOTA_OUTPUT)

    expect(rows).toEqual([
      { family: 'Gemini Models', windowMinutes: 10080, usedPercent: 2, resetsAt: 1790154487000 },
      { family: 'Gemini Models', windowMinutes: 300, usedPercent: 13, resetsAt: 1789567687000 },
      {
        family: 'Claude and GPT models',
        windowMinutes: 10080,
        usedPercent: 0,
        resetsAt: 1790159851000
      },
      {
        family: 'Claude and GPT models',
        windowMinutes: 300,
        usedPercent: 0,
        resetsAt: 1789573051000
      }
    ])
  })

  it('skips startup notices, blank lines, unrecognized labels and unparseable values', () => {
    const rows = parseAntigravityQuotaRows(
      [
        'You are currently not signed in.',
        '',
        'Gemini Models\tMonthly Limit Remaining\t50%\t2026-09-23T09:08:07Z',
        'Gemini Models\tFive Hour Limit Remaining\tn/a\tabc',
        'Claude and GPT models\tFive Hour Limit Remaining\t40%\tnot-a-date'
      ].join('\n')
    )

    expect(rows).toEqual([
      { family: 'Claude and GPT models', windowMinutes: 300, usedPercent: 60, resetsAt: null }
    ])
  })

  it('clamps a remaining value that would invert past the window bounds', () => {
    const [row] = parseAntigravityQuotaRows(
      'Gemini Models\tFive Hour Limit Remaining\t120%\t2026-09-16T14:08:07Z'
    )

    expect(row?.usedPercent).toBe(0)
  })
})

describe('buildAntigravityRateLimits', () => {
  it('reports both families as buckets and the primary family as the session chip', () => {
    const limits = buildAntigravityRateLimits(
      parseAntigravityQuotaRows(CAPTURED_QUOTA_OUTPUT),
      1_700_000_000_000
    )

    expect(limits.provider).toBe('antigravity')
    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
    expect(limits.updatedAt).toBe(1_700_000_000_000)
    expect(limits.session?.usedPercent).toBe(13)
    expect(limits.session?.windowMinutes).toBe(300)
    expect(limits.weekly).toBeNull()
    expect(limits.buckets?.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · Weekly',
      'Gemini Models · 5h',
      'Claude and GPT models · Weekly',
      'Claude and GPT models · 5h'
    ])
  })

  it('uses the weekly Gemini bucket when its five-hour window is absent', () => {
    const limits = buildAntigravityRateLimits(
      parseAntigravityQuotaRows('Gemini Models\tWeekly Limit Remaining\t20%\t2026-09-16T15:37:31Z')
    )
    expect(limits.session).toMatchObject({ usedPercent: 80, windowMinutes: 10080 })
  })

  it('keeps the buckets when the primary family is absent', () => {
    const limits = buildAntigravityRateLimits(
      parseAntigravityQuotaRows(
        'Claude and GPT models\tFive Hour Limit Remaining\t40%\t2026-09-16T15:37:31Z'
      )
    )

    expect(limits.session?.usedPercent).toBe(60)
    expect(limits.buckets).toHaveLength(1)
    expect(limits.buckets?.[0]?.usedPercent).toBe(60)
  })
})
