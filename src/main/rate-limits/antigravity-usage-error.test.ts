import { describe, expect, it } from 'vitest'
import { classifyAntigravityUsageFailure } from './antigravity-usage-error'

/** Captured verbatim from agy 1.2.11 when the account had exhausted its weekly pool. */
const REAL_RESOURCE_EXHAUSTED =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h51m3s.\n' +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h51m3s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"6baa4ce9-c373-4086-bb0d-fbb8421bacf3-1"}'

function agyError(fields: Record<string, unknown>): string {
  return `AGY_ERROR: ${JSON.stringify(fields)}`
}

describe('classifyAntigravityUsageFailure', () => {
  it('reads the real RESOURCE_EXHAUSTED diagnostic as rate limiting, not as a sign-out', () => {
    const failure = classifyAntigravityUsageFailure(REAL_RESOURCE_EXHAUSTED)

    expect(failure).toEqual({ failureKind: 'rate-limited', signedOut: false })
  })

  it.each([
    ['status', { status: 'UNAUTHENTICATED' }],
    ['http code', { error_code: 401 }]
  ])('reads an unauthenticated %s as a missing sign-in', (_label, fields) => {
    expect(classifyAntigravityUsageFailure(agyError(fields))).toEqual({
      failureKind: 'missing-credentials',
      signedOut: true
    })
  })

  it('separates an unentitled account from a signed-out one', () => {
    // Why this matters: telling a signed-in user to sign in sends them to re-auth that fixes
    // nothing.
    expect(classifyAntigravityUsageFailure(agyError({ status: 'PERMISSION_DENIED' }))).toEqual({
      failureKind: 'no-subscription',
      signedOut: false
    })
  })

  it('reads a 5xx as a server failure', () => {
    expect(classifyAntigravityUsageFailure(agyError({ error_code: 503 }))).toEqual({
      failureKind: 'server',
      signedOut: false
    })
  })

  it.each([
    'You are not logged into Antigravity.',
    'Error: not signed in. Run `agy` to continue.',
    'please sign in to continue',
    'AUTHENTICATION REQUIRED'
  ])('falls back to the sentence when no structured error is printed: %s', (output) => {
    // Why a fallback at all: the structured line is the stable signal, but not every path prints
    // one, and a signed-out account must never be reported as an unreadable payload.
    expect(classifyAntigravityUsageFailure(output)).toEqual({
      failureKind: 'missing-credentials',
      signedOut: true
    })
  })

  it('prefers the structured status over a sentence that disagrees with it', () => {
    const output = `not logged in\n${agyError({ status: 'RESOURCE_EXHAUSTED' })}`

    expect(classifyAntigravityUsageFailure(output)).toEqual({
      failureKind: 'rate-limited',
      signedOut: false
    })
  })

  it.each([
    ['a successful read', '{"status":"SUCCESS","command":{"name":"usage"}}'],
    ['unrelated noise', 'I0926 quota_manager.go:45] doRefreshQuota: starting reload'],
    ['an unparsable structured line', 'AGY_ERROR: {not json'],
    ['an unrecognised status', agyError({ status: 'SOMETHING_NEW' })],
    ['empty output', '']
  ])('returns null for %s rather than inventing a cause', (_label, output) => {
    expect(classifyAntigravityUsageFailure(output)).toBeNull()
  })
})
