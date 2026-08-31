import { describe, expect, it } from 'vitest'
import { parseAntigravityCliUsage } from './antigravity-cli-usage'

// Real `agy -p "/usage"` output: family, window label, remaining percentage, reset instant.
const SAMPLE = [
  'Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-02T17:02:52Z',
  'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-08-26T22:02:52Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-02T17:02:52Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-08-26T22:02:52Z'
].join('\n')

const UPDATED_AT = 1_700_000_000_000

describe('parseAntigravityCliUsage', () => {
  it('maps the five hour row to the session window', () => {
    const limits = parseAntigravityCliUsage(SAMPLE, UPDATED_AT)

    expect(limits.provider).toBe('antigravity')
    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
    expect(limits.session?.windowMinutes).toBe(300)
    expect(limits.session?.resetsAt).toBe(Date.parse('2026-08-26T22:02:52Z'))
  })

  it('maps the weekly row to the weekly window', () => {
    const limits = parseAntigravityCliUsage(SAMPLE, UPDATED_AT)

    expect(limits.weekly?.windowMinutes).toBe(10080)
    expect(limits.weekly?.resetsAt).toBe(Date.parse('2026-09-02T17:02:52Z'))
  })

  // Why: the CLI reports what is left, but every other provider in Orca reports what is spent.
  it('converts remaining percentage into used percentage', () => {
    const limits = parseAntigravityCliUsage(SAMPLE, UPDATED_AT)

    expect(limits.session?.usedPercent).toBe(0)
    expect(limits.weekly?.usedPercent).toBe(0)

    const partial = parseAntigravityCliUsage(
      'Gemini Models\tFive Hour Limit Remaining\t42%\t2026-08-26T22:02:52Z',
      UPDATED_AT
    )

    expect(partial.session?.usedPercent).toBe(58)
  })

  // Why: the CLI prints both families; Gemini is the provider's own quota and must win.
  it('prefers the Gemini family over the Claude and GPT family', () => {
    const limits = parseAntigravityCliUsage(
      [
        'Claude and GPT models\tFive Hour Limit Remaining\t10%\t2026-08-26T22:02:52Z',
        'Gemini Models\tFive Hour Limit Remaining\t70%\t2026-08-26T22:02:52Z'
      ].join('\n'),
      UPDATED_AT
    )

    expect(limits.session?.usedPercent).toBe(30)
  })

  it('reports unavailable when no usage row can be read', () => {
    const limits = parseAntigravityCliUsage('Please sign in to view usage.', UPDATED_AT)

    expect(limits.status).toBe('unavailable')
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
    expect(limits.error).toBeTruthy()
  })

  // Why: Antigravity bills two independent pools with their own resets (see #9122),
  // so both must survive as named buckets, not just the headline Gemini numbers.
  it('exposes both quota pools as named buckets', () => {
    const limits = parseAntigravityCliUsage(SAMPLE, UPDATED_AT)

    expect(limits.buckets?.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · 7d',
      'Gemini Models · 5h',
      'Claude and GPT models · 7d',
      'Claude and GPT models · 5h'
    ])
  })

  it('marks the source as cli so the meter can explain itself', () => {
    expect(parseAntigravityCliUsage(SAMPLE, UPDATED_AT).usageMetadata?.source).toBe('cli')
    expect(parseAntigravityCliUsage('nope', UPDATED_AT).usageMetadata?.failureKind).toBe(
      'usage-unavailable'
    )
  })
})
