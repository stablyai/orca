import { describe, expect, it } from 'vitest'
import {
  parseAntigravityUsageEnvelope,
  parseAntigravityUsageStdout
} from './antigravity-usage-response'

/**
 * Captured verbatim from `agy -p "/usage" --output-format json` on agy 1.2.11 (macOS arm64).
 * A tier with no 5h bucket reports weekly alone, which is why `session` is null here.
 */
const REAL_AGY_1_2_11_STDOUT = `{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t100%\\t2026-10-07T08:08:35Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t100%\\t2026-10-07T08:08:35Z\\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-07T08:08:35Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-07T08:08:35Z"}]}]}}}`

function envelope(groups: unknown, description = 'pool help'): unknown {
  return {
    status: 'SUCCESS',
    command: { name: 'usage', data: { description, groups } }
  }
}

describe('parseAntigravityUsageStdout', () => {
  it('reads the real agy 1.2.11 payload as two weekly group pools', () => {
    const reading = parseAntigravityUsageStdout(REAL_AGY_1_2_11_STDOUT)

    expect(reading).not.toBeNull()
    expect(reading?.buckets).toEqual([
      {
        id: 'gemini-weekly',
        name: 'Gemini Models',
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: new Date('2026-10-07T08:08:35Z').getTime(),
        resetDescription: null
      },
      {
        id: '3p-weekly',
        name: 'Claude and GPT models',
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: new Date('2026-10-07T08:08:35Z').getTime(),
        resetDescription: null
      }
    ])
  })

  it('reports the weekly window the Gemini mirror always left null', () => {
    const reading = parseAntigravityUsageStdout(REAL_AGY_1_2_11_STDOUT)

    expect(reading?.weekly).toEqual({
      usedPercent: 0,
      windowMinutes: 10_080,
      resetsAt: new Date('2026-10-07T08:08:35Z').getTime(),
      resetDescription: null
    })
    // Why null: this tier meters no 5h pool, and inventing one would claim headroom agy never
    // reported.
    expect(reading?.session).toBeNull()
  })

  it('ignores log noise printed around the envelope', () => {
    const reading = parseAntigravityUsageStdout(
      `I0926 16:22:51.157090 quota_manager.go:36] doRefreshQuota\n${REAL_AGY_1_2_11_STDOUT}\nBye.`
    )

    expect(reading?.buckets).toHaveLength(2)
  })

  it('returns null for stdout with no envelope at all', () => {
    expect(parseAntigravityUsageStdout('You are not logged into Antigravity.')).toBeNull()
    expect(parseAntigravityUsageStdout('')).toBeNull()
    expect(parseAntigravityUsageStdout('{ not json')).toBeNull()
  })
})

describe('parseAntigravityUsageEnvelope', () => {
  it('maps a 5h bucket onto the session window and weekly onto the weekly window', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-5h',
              name: '5h Limit Remaining',
              window: '5h',
              remaining_fraction: 0.25,
              reset_time: '2026-09-30T12:00:00Z'
            },
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.5,
              reset_time: '2026-10-07T00:00:00Z'
            }
          ]
        }
      ])
    )

    expect(reading?.session).toMatchObject({ usedPercent: 75, windowMinutes: 300 })
    expect(reading?.weekly).toMatchObject({ usedPercent: 50, windowMinutes: 10_080 })
  })

  it('names both windows of one group apart', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', name: '5h', window: '5h', remaining_fraction: 1 },
            { id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 1 }
          ]
        }
      ])
    )

    expect(reading?.buckets.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · Weekly'
    ])
  })

  it('drops a disabled bucket instead of drawing it as unused', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'Gemini Models',
          buckets: [
            // The #22511 account: the 5h pool is not metered and the weekly pool is exhausted.
            { id: 'gemini-5h', name: '5h', window: '5h', remaining_fraction: 1, disabled: true },
            {
              id: 'gemini-weekly',
              name: 'Weekly',
              window: 'weekly',
              remaining_fraction: 0,
              reset_time: '2026-10-01T00:00:00Z'
            }
          ]
        }
      ])
    )

    expect(reading?.buckets).toHaveLength(1)
    expect(reading?.buckets[0]).toMatchObject({ id: 'gemini-weekly', usedPercent: 100 })
    expect(reading?.session).toBeNull()
    expect(reading?.weekly?.usedPercent).toBe(100)
    // Why the single bucket keeps the bare group name: the disabled sibling is not a row.
    expect(reading?.buckets[0]?.name).toBe('Gemini Models')
  })

  it('summarises each window by its most constrained group', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'Gemini Models',
          buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9 }]
        },
        {
          name: 'Claude and GPT models',
          buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.1 }]
        }
      ])
    )

    // Why the worst pool: the tier is out of Antigravity when either group is out.
    expect(reading?.weekly?.usedPercent).toBe(90)
  })

  it('keeps an unrecognised window as a named bucket without claiming a duration', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'Gemini Models',
          buckets: [{ id: 'gemini-monthly', window: 'monthly', remaining_fraction: 0.4 }]
        }
      ])
    )

    expect(reading?.buckets[0]).toMatchObject({ usedPercent: 60, windowMinutes: 0 })
    expect(reading?.session).toBeNull()
    expect(reading?.weekly).toBeNull()
  })

  it('carries agy’s own pool explanation through', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope(
        [
          { name: 'Gemini Models', buckets: [{ id: 'g', window: 'weekly', remaining_fraction: 1 }] }
        ],
        'Quota is consumed proportionally to the cost of the tokens.'
      )
    )

    expect(reading?.description).toBe('Quota is consumed proportionally to the cost of the tokens.')
  })

  it('clamps a fraction outside 0..1', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'G',
          buckets: [
            { id: 'a', window: 'weekly', remaining_fraction: 1.4 },
            { id: 'b', window: '5h', remaining_fraction: -0.2 }
          ]
        }
      ])
    )

    expect(reading?.buckets.map((bucket) => bucket.usedPercent)).toEqual([0, 100])
  })

  it('reads a missing or unparsable reset time as unknown', () => {
    const reading = parseAntigravityUsageEnvelope(
      envelope([
        {
          name: 'G',
          buckets: [{ id: 'a', window: 'weekly', remaining_fraction: 1, reset_time: 'soon' }]
        }
      ])
    )

    expect(reading?.buckets[0]?.resetsAt).toBeNull()
  })

  it.each([
    ['a non-SUCCESS status', { status: 'ERROR', command: { name: 'usage', data: { groups: [] } } }],
    ['another command’s payload', { status: 'SUCCESS', command: { name: 'models', data: {} } }],
    ['a missing command', { status: 'SUCCESS' }],
    ['no groups', envelope(undefined)],
    ['an empty group list', envelope([])],
    ['a group with no usable bucket', envelope([{ name: 'G', buckets: [{ id: 'a' }] }])],
    [
      'a group with every bucket disabled',
      envelope([
        {
          name: 'G',
          buckets: [{ id: 'a', window: 'weekly', remaining_fraction: 1, disabled: true }]
        }
      ])
    ],
    ['a non-object', 'nope'],
    ['null', null]
  ])('returns null for %s', (_label, value) => {
    expect(parseAntigravityUsageEnvelope(value)).toBeNull()
  })
})
