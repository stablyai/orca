import { describe, expect, it } from 'vitest'
import { classifyAntigravityUsageFailure } from './antigravity-usage-error'

/** Captured verbatim from agy 1.2.11 when the account had exhausted its weekly pool. */
const REAL_RESOURCE_EXHAUSTED =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h51m3s.\n' +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 167h51m3s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"6baa4ce9-c373-4086-bb0d-fbb8421bacf3-1"}'

describe('classifyAntigravityUsageFailure', () => {
  it('reads the real RESOURCE_EXHAUSTED diagnostic as rate limiting, not as a sign-out', () => {
    const failure = classifyAntigravityUsageFailure(REAL_RESOURCE_EXHAUSTED)

    expect(failure).toEqual({ failureKind: 'rate-limited', signedOut: false })
  })
})
