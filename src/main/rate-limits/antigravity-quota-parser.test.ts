import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaSummary } from './antigravity-quota-parser'

const quotaSummary = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            remainingFraction: 0.916,
            resetTime: '2026-07-16T21:59:04Z'
          },
          {
            bucketId: 'gemini-5h',
            remainingFraction: 1,
            resetTime: '2026-07-14T16:30:11Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-weekly',
            remainingFraction: 0.988,
            resetTime: '2026-07-21T11:28:50Z'
          },
          {
            bucketId: '3p-5h',
            remainingFraction: 0.964,
            resetTime: '2026-07-14T16:28:50Z'
          }
        ]
      }
    ]
  }
}

describe('parseAntigravityQuotaSummary', () => {
  it('keeps both quota families while deriving compatible summary windows', () => {
    const result = parseAntigravityQuotaSummary(quotaSummary, 1234)

    expect(result).toMatchObject({
      provider: 'antigravity',
      session: { usedPercent: 4, windowMinutes: 300 },
      weekly: { usedPercent: 8, windowMinutes: 10_080 },
      updatedAt: 1234,
      status: 'ok'
    })
    expect(result?.buckets?.map(({ name, usedPercent }) => ({ name, usedPercent }))).toEqual([
      { name: 'Gemini 5h', usedPercent: 0 },
      { name: 'Gemini wk', usedPercent: 8 },
      { name: 'Claude/GPT 5h', usedPercent: 4 },
      { name: 'Claude/GPT wk', usedPercent: 1 }
    ])
  })

  it('accepts the root-level groups shape returned by some AGY versions', () => {
    expect(parseAntigravityQuotaSummary(quotaSummary.response)?.buckets).toHaveLength(4)
  })

  it('keeps recognized buckets when reset metadata is absent', () => {
    const withoutReset = structuredClone(quotaSummary)
    delete (withoutReset.response.groups[0].buckets[0] as { resetTime?: string }).resetTime

    expect(parseAntigravityQuotaSummary(withoutReset)?.buckets?.[1]).toMatchObject({
      name: 'Gemini wk',
      usedPercent: 8,
      resetsAt: null
    })
  })

  it('keeps the most constrained value when a response duplicates a bucket identity', () => {
    const duplicated = structuredClone(quotaSummary)
    duplicated.response.groups[1].buckets.push({
      bucketId: 'gemini-weekly',
      remainingFraction: 0.25,
      resetTime: '2026-07-16T21:59:04Z'
    })

    expect(parseAntigravityQuotaSummary(duplicated)?.buckets?.[1]?.usedPercent).toBe(75)
  })

  it('rejects malformed and unknown-only responses', () => {
    expect(parseAntigravityQuotaSummary({ response: { groups: [] } })).toBeNull()
    expect(
      parseAntigravityQuotaSummary({
        response: {
          groups: [{ buckets: [{ bucketId: 'future-window', remainingFraction: 0.5 }] }]
        }
      })
    ).toBeNull()
    expect(parseAntigravityQuotaSummary(null)).toBeNull()
  })
})
