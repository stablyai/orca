import { describe, expect, it } from 'vitest'
import {
  decideQuotaFallback,
  type QuotaFallbackInput,
  type QuotaFallbackCandidate
} from './quota-fallback-policy'

const now = 1_000_000
const ag: QuotaFallbackCandidate = {
  route: 'antigravity-opus',
  observedAt: now,
  available: true,
  modelCompatible: true,
  fiveHourRemaining: 50,
  weeklyRemaining: 50
}
const api: QuotaFallbackCandidate = {
  route: 'claude-api',
  observedAt: now,
  available: true,
  modelCompatible: true,
  credit: { remainingUsd: 10, maxDebitUsd: 1, expiresAt: now + 60_000, paidOverflowBlocked: true }
}
function input(overrides: Partial<QuotaFallbackInput> = {}): QuotaFallbackInput {
  return {
    enabled: true,
    provider: 'claude',
    billing: 'subscription',
    errorCode: 'usage_limit_reached',
    turnId: 'turn-1',
    currentTurnId: 'turn-1',
    settled: true,
    pending: false,
    candidates: [api, ag],
    now,
    ...overrides
  }
}

describe('confirmed subscription quota fallback', () => {
  it('prefers AG independently of candidate ordering', () => {
    expect(decideQuotaFallback(input())).toEqual({ kind: 'switch', route: 'antigravity-opus' })
  })
  it('uses verified Claude API when either AG window is exhausted', () => {
    for (const window of ['fiveHourRemaining', 'weeklyRemaining']) {
      expect(decideQuotaFallback(input({ candidates: [{ ...ag, [window]: 0 }, api] }))).toEqual({
        kind: 'switch',
        route: 'claude-api'
      })
    }
  })
  it('routes Codex exclusively to OpenAI API', () => {
    expect(
      decideQuotaFallback(
        input({
          provider: 'codex',
          errorCode: 'usageLimitExceeded',
          candidates: [ag, api, { ...api, route: 'openai-api' }]
        })
      )
    ).toEqual({ kind: 'switch', route: 'openai-api' })
  })
  it.each([
    '429',
    'rate_limit',
    'rateLimitExceeded',
    'timeout',
    'authentication_error',
    '',
    'insufficient_quota'
  ])('does not switch for ambiguous or different error %s', (errorCode) => {
    expect(decideQuotaFallback(input({ errorCode })).kind).toBe('hold')
  })
  it.each([
    { enabled: false },
    { billing: 'api' as const },
    { settled: false },
    { pending: true },
    { currentTurnId: 'new-turn' },
    { turnId: '' },
    { now: Number.NaN }
  ])('holds unsafe source state %j', (overrides) => {
    expect(decideQuotaFallback(input(overrides)).kind).toBe('hold')
  })
  it.each([now - 60_001, now + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects stale or invalid observations %s',
    (observedAt) => {
      expect(decideQuotaFallback(input({ candidates: [{ ...api, observedAt }] })).kind).toBe('hold')
    }
  )
  it.each([
    { remainingUsd: 0 },
    { remainingUsd: Number.NaN },
    { maxDebitUsd: 11 },
    { maxDebitUsd: 0 },
    { maxDebitUsd: Number.POSITIVE_INFINITY },
    { expiresAt: now },
    { paidOverflowBlocked: false }
  ])('requires bounded free credit %j', (credit) => {
    expect(
      decideQuotaFallback(
        input({
          candidates: [
            {
              ...api,
              credit: {
                remainingUsd: 10,
                maxDebitUsd: 1,
                expiresAt: now + 60_000,
                paidOverflowBlocked: true,
                ...credit
              }
            }
          ]
        })
      ).kind
    ).toBe('hold')
  })
  it('does not infer credit evidence from authenticated API access', () => {
    expect(decideQuotaFallback(input({ candidates: [{ ...api, credit: undefined }] })).kind).toBe(
      'hold'
    )
  })
  it('does not replace an exact model with an incompatible model', () => {
    expect(
      decideQuotaFallback(input({ candidates: [{ ...ag, modelCompatible: false }] })).kind
    ).toBe('hold')
  })
  it('rejects conflicting duplicate observations for a route', () => {
    expect(decideQuotaFallback(input({ candidates: [api, api] })).kind).toBe('hold')
  })
})
