import { describe, expect, it } from 'vitest'
import { parseMuseUsageStdout } from './muse-usage-response'

const NOW = 1_800_000_000_000
const RESET = NOW + 60_000

function reading(allowance: unknown): string {
  return JSON.stringify({ schemaVersion: 1, allowance })
}

describe('Muse quota response', () => {
  it('maps reported percentages, durations, and millisecond reset times without conversion', () => {
    const result = parseMuseUsageStdout(
      reading({
        tier: 'PRO',
        asOfMs: NOW - 10_000,
        window: { usedPercent: 12.5, windowDurationMins: 180, resetsAtMs: RESET },
        weekly: { usedPercent: 100, windowDurationMins: 10_080, resetsAtMs: RESET + 1 }
      }),
      NOW
    )

    expect(result).toMatchObject({
      provider: 'muse',
      status: 'ok',
      planType: 'PRO',
      updatedAt: NOW - 10_000,
      session: { usedPercent: 12.5, windowMinutes: 180, resetsAt: RESET },
      weekly: { usedPercent: 100, windowMinutes: 10_080, resetsAt: RESET + 1 }
    })
  })

  it('accepts a partial allowance and preserves a reported zero', () => {
    const result = parseMuseUsageStdout(
      reading({
        window: null,
        weekly: { usedPercent: 0, windowDurationMins: 10_080 }
      }),
      NOW
    )

    expect(result?.session).toBeNull()
    expect(result?.weekly).toEqual({
      usedPercent: 0,
      windowMinutes: 10_080,
      resetsAt: null,
      resetDescription: null
    })
  })

  it('caps a future observation time at the local clock', () => {
    expect(
      parseMuseUsageStdout(
        reading({
          asOfMs: NOW + 5_000,
          window: { usedPercent: 20, windowDurationMins: 60 }
        }),
        NOW
      )?.updatedAt
    ).toBe(NOW)
  })

  it('accepts the live Muse 1.4.13 shape with documented window durations omitted', () => {
    const result = parseMuseUsageStdout(
      '{"schemaVersion":1,"allowance":{"tier":"Muse Code High Usage","window":{"usedPercent":4,"resetsAtMs":1793080227000},"weekly":{"usedPercent":7,"resetsAtMs":1793577600000},"asOfMs":1793062370130,"source":"mint"},"reason":null,"hint":null}',
      NOW
    )

    expect(result).toMatchObject({
      status: 'ok',
      updatedAt: 1793062370130,
      session: { usedPercent: 4, windowMinutes: 300, resetsAt: 1793080227000 },
      weekly: { usedPercent: 7, windowMinutes: 10_080, resetsAt: 1793577600000 }
    })
  })

  it('preserves valid over-quota percentages for shared display clamping', () => {
    const result = parseMuseUsageStdout(
      reading({ window: { usedPercent: 125 }, weekly: { usedPercent: 101 } }),
      NOW
    )

    expect(result).toMatchObject({
      status: 'ok',
      session: { usedPercent: 125 },
      weekly: { usedPercent: 101 }
    })
  })

  it('reports an explicit null allowance as unavailable without claiming zero usage', () => {
    const result = parseMuseUsageStdout(
      JSON.stringify({
        schemaVersion: 1,
        allowance: null,
        reason: 'server_sent_no_usage'
      }),
      NOW
    )

    expect(result).toMatchObject({
      status: 'unavailable',
      session: null,
      weekly: null,
      usageMetadata: { source: 'cli', failureKind: 'usage-unavailable' }
    })
  })

  it.each([
    { usedPercent: -1, windowDurationMins: 60 },
    { usedPercent: '25', windowDurationMins: 60 },
    { windowDurationMins: 60 },
    { usedPercent: 25, windowDurationMins: 0 },
    { usedPercent: 25, windowDurationMins: -1 },
    { usedPercent: 25, windowDurationMins: 60, resetsAtMs: '2027-01-01' },
    { usedPercent: 25, windowDurationMins: 60, resetsAtMs: -1 },
    { usedPercent: 25, windowDurationMins: 60, resetsAtMs: 9e18 }
  ])('rejects malformed allowance windows (%j)', (window) => {
    expect(parseMuseUsageStdout(reading({ window }), NOW)).toBeNull()
  })

  it('rejects a malformed observation timestamp even when usage is valid', () => {
    expect(
      parseMuseUsageStdout(
        reading({
          asOfMs: '1800000000000',
          window: { usedPercent: 25, windowDurationMins: 60 }
        }),
        NOW
      )
    ).toBeNull()
  })

  it.each(['', '{', '[]', '{}', '{"schemaVersion":1}', '{"schemaVersion":2,"allowance":null}'])(
    'rejects invalid or unsupported envelopes (%s)',
    (stdout) => {
      expect(parseMuseUsageStdout(stdout, NOW)).toBeNull()
    }
  )
})
