import { describe, expect, it } from 'vitest'
import {
  isOpenCodeGoExplicitNoAccessPayload,
  parseOpenCodeGoBillingStatusPayload,
  parseOpenCodeGoStatusPayload,
  parseOpenCodeGoUsageApiPayload
} from './opencode-go-status-parsing'

const ISSUE_PAYLOAD = {
  access: {
    meters: {
      fiveHour: {
        resetsAt: '2026-09-18T12:42:04.962Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '121745383'
      },
      week: {
        resetsAt: '2026-09-21T00:00:00.000Z',
        limitMicroCents: '3000000000',
        usedMicroCents: '121745383'
      },
      month: {
        limitMicroCents: '6000000000',
        usedMicroCents: '121745383'
      }
    }
  }
}

describe('parseOpenCodeGoStatusPayload', () => {
  it('maps fiveHour/week/month meters into session/weekly/monthly windows', () => {
    const parsed = parseOpenCodeGoStatusPayload(JSON.stringify(ISSUE_PAYLOAD))

    expect(parsed).not.toBeNull()
    expect(parsed?.session).toEqual({
      usedPercent: (121745383 / 1_200_000_000) * 100,
      windowMinutes: 300,
      resetsAt: Date.parse('2026-09-18T12:42:04.962Z'),
      resetDescription: null
    })
    expect(parsed?.weekly).toEqual({
      usedPercent: (121745383 / 3_000_000_000) * 100,
      windowMinutes: 10_080,
      resetsAt: Date.parse('2026-09-21T00:00:00.000Z'),
      resetDescription: null
    })
    expect(parsed?.monthly).toEqual({
      usedPercent: (121745383 / 6_000_000_000) * 100,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null
    })
  })

  it('accepts numeric microCents', () => {
    const parsed = parseOpenCodeGoStatusPayload(
      JSON.stringify({
        access: {
          meters: {
            fiveHour: {
              resetsAt: '2026-09-18T12:42:04.962Z',
              limitMicroCents: 100,
              usedMicroCents: 25
            },
            week: {
              resetsAt: '2026-09-21T00:00:00.000Z',
              limitMicroCents: 200,
              usedMicroCents: 50
            }
          }
        }
      })
    )

    expect(parsed?.session?.usedPercent).toBe(25)
    expect(parsed?.weekly?.usedPercent).toBe(25)
    expect(parsed?.monthly).toBeNull()
  })

  it('caps usedPercent at 100 and floors at 0', () => {
    const parsed = parseOpenCodeGoStatusPayload(
      JSON.stringify({
        access: {
          meters: {
            fiveHour: {
              resetsAt: '2026-09-18T12:42:04.962Z',
              limitMicroCents: '100',
              usedMicroCents: '150'
            },
            week: {
              resetsAt: '2026-09-21T00:00:00.000Z',
              limitMicroCents: '100',
              usedMicroCents: '-5'
            }
          }
        }
      })
    )

    expect(parsed?.session?.usedPercent).toBe(100)
    expect(parsed?.weekly?.usedPercent).toBe(0)
  })

  it('returns null for HTML and other non-JSON bodies', () => {
    expect(parseOpenCodeGoStatusPayload('<html>rollingUsage:{usagePercent:30}</html>')).toBeNull()
    expect(parseOpenCodeGoStatusPayload('')).toBeNull()
    expect(parseOpenCodeGoStatusPayload('{not json')).toBeNull()
  })

  it('returns null when fiveHour or week meters are missing', () => {
    expect(
      parseOpenCodeGoStatusPayload(
        JSON.stringify({
          access: {
            meters: {
              week: { limitMicroCents: '100', usedMicroCents: '10' }
            }
          }
        })
      )
    ).toBeNull()
  })
})

describe('parseOpenCodeGoBillingStatusPayload', () => {
  it('maps the verified PAYG micro-cent string into USD major units', () => {
    expect(
      parseOpenCodeGoBillingStatusPayload(
        JSON.stringify({
          billingMode: 'prepaid',
          mode: 'pay-as-you-go',
          balanceMicroCents: '2786781005'
        })
      )
    ).toBe(27.86781005)
  })

  it('preserves zero and negative balances', () => {
    expect(
      parseOpenCodeGoBillingStatusPayload(
        JSON.stringify({
          billingMode: 'prepaid',
          mode: 'pay-as-you-go',
          balanceMicroCents: '0'
        })
      )
    ).toBe(0)
    expect(
      parseOpenCodeGoBillingStatusPayload(
        JSON.stringify({
          billingMode: 'prepaid',
          mode: 'pay-as-you-go',
          balanceMicroCents: '-125000000'
        })
      )
    ).toBe(-1.25)
  })

  it.each([
    { billingMode: 'credit', mode: 'pay-as-you-go', balanceMicroCents: '100000000' },
    { billingMode: 'seat', mode: 'pay-as-you-go', balanceMicroCents: '100000000' },
    { billingMode: 'prepaid', mode: 'invoiceable', balanceMicroCents: '100000000' },
    { billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: 100000000 },
    { billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: '1.5' },
    {
      billingMode: 'prepaid',
      mode: 'pay-as-you-go',
      balanceMicroCents: '9007199254740992'
    }
  ])('rejects unsupported or unsafe billing payloads: $billingMode/$mode', (payload) => {
    expect(parseOpenCodeGoBillingStatusPayload(JSON.stringify(payload))).toBeNull()
  })

  it('fails closed for malformed and non-object bodies', () => {
    expect(parseOpenCodeGoBillingStatusPayload('{not json')).toBeNull()
    expect(parseOpenCodeGoBillingStatusPayload('[]')).toBeNull()
    expect(parseOpenCodeGoBillingStatusPayload('')).toBeNull()
  })
})

describe('isOpenCodeGoExplicitNoAccessPayload', () => {
  it('accepts only explicit JSON null or access:null without an error verdict', () => {
    expect(isOpenCodeGoExplicitNoAccessPayload('null')).toBe(true)
    expect(isOpenCodeGoExplicitNoAccessPayload('{"access":null}')).toBe(true)
    expect(
      isOpenCodeGoExplicitNoAccessPayload('{"access":null,"error":{"type":"AuthError"}}')
    ).toBe(false)
    expect(isOpenCodeGoExplicitNoAccessPayload('{"access":{}}')).toBe(false)
    expect(isOpenCodeGoExplicitNoAccessPayload('{}')).toBe(false)
    expect(isOpenCodeGoExplicitNoAccessPayload('<html></html>')).toBe(false)
    expect(isOpenCodeGoExplicitNoAccessPayload('{not json')).toBe(false)
  })
})

describe('parseOpenCodeGoUsageApiPayload', () => {
  it('clamps an out-of-range percent and tolerates a missing resetsAt', () => {
    const parsed = parseOpenCodeGoUsageApiPayload(
      JSON.stringify({
        usage: {
          rolling: { status: 'rate-limited', percent: 140 },
          weekly: { status: 'ok', percent: -5, resetsAt: 'not a date' }
        }
      })
    )

    expect(parsed?.session).toEqual({
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    })
    expect(parsed?.weekly.usedPercent).toBe(0)
    expect(parsed?.monthly).toBeNull()
  })

  it('returns null for the console error bodies and other non-usage payloads', () => {
    expect(
      parseOpenCodeGoUsageApiPayload(
        JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } })
      )
    ).toBeNull()
    expect(parseOpenCodeGoUsageApiPayload('{not json')).toBeNull()
    expect(parseOpenCodeGoUsageApiPayload('')).toBeNull()
  })
})
