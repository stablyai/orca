import { describe, it, expect } from 'vitest'
import { classifyError } from './classify-error'

describe('classifyError', () => {
  it('classifies whitelisted Error subclass names by their declared name', () => {
    const err = Object.assign(new Error('whatever'), { name: 'NetworkTimeout' })
    expect(classifyError(err)).toEqual({
      error_class: 'network_timeout',
      error_name: 'NetworkTimeout'
    })
  })

  it('falls back to message substring matching for plain Error', () => {
    const err = new Error('connection ETIMEDOUT after 30s')
    expect(classifyError(err)).toEqual({ error_class: 'network_timeout' })
  })

  it('matches "rate limit" before generic "auth"', () => {
    const err = new Error('rate limit exceeded for this auth context')
    // First-match-wins on the hint table — `rate limit` is declared first.
    expect(classifyError(err)).toEqual({ error_class: 'rate_limited' })
  })

  it('classifies 401/unauthorized as auth_expired', () => {
    expect(classifyError(new Error('HTTP 401 unauthorized'))).toEqual({
      error_class: 'auth_expired'
    })
  })

  it('classifies ENOENT as binary_not_found', () => {
    expect(classifyError(new Error('spawn claude ENOENT'))).toEqual({
      error_class: 'binary_not_found'
    })
  })

  it('classifies AbortError-style cancellation as user_cancelled', () => {
    expect(classifyError(new Error('operation was aborted'))).toEqual({
      error_class: 'user_cancelled'
    })
  })

  it('returns unknown for null/undefined input', () => {
    expect(classifyError(null)).toEqual({ error_class: 'unknown' })
    expect(classifyError(undefined)).toEqual({ error_class: 'unknown' })
  })

  it('returns unknown for an unrecognized message', () => {
    expect(classifyError(new Error('some unique failure mode we do not know'))).toEqual({
      error_class: 'unknown'
    })
  })

  it('does not leak unmapped error_name from a non-whitelisted Error subclass', () => {
    const err = Object.assign(new Error('boom'), { name: 'PaymentFailedForUserAlice' })
    // Unmapped name → no error_name key on the wire; `error_class` stays
    // 'unknown' rather than emitting a free-form identifier.
    expect(classifyError(err)).toEqual({ error_class: 'unknown' })
  })
})
