import { describe, expect, it } from 'vitest'
import {
  classifyGrokBillingHttpFailure,
  isMissingPersonalTeamError,
  parseGrokBillingErrorDetail
} from './grok-billing-error'

describe('parseGrokBillingErrorDetail', () => {
  it('reads the xAI error string', () => {
    expect(parseGrokBillingErrorDetail('{"error":"No personal team."}')).toBe('No personal team.')
  })

  it('returns null for empty, non-JSON, or error-less bodies', () => {
    expect(parseGrokBillingErrorDetail('')).toBeNull()
    expect(parseGrokBillingErrorDetail('<html>nope</html>')).toBeNull()
    expect(parseGrokBillingErrorDetail('{"code":"x"}')).toBeNull()
  })
})

describe('isMissingPersonalTeamError', () => {
  it('matches the credits and default billing wordings', () => {
    expect(isMissingPersonalTeamError('No personal team.')).toBe(true)
    expect(isMissingPersonalTeamError('resolve_personal_team_id(), No personal team.')).toBe(true)
    expect(isMissingPersonalTeamError('If-Match failed')).toBe(false)
    expect(isMissingPersonalTeamError(null)).toBe(false)
  })
})

describe('classifyGrokBillingHttpFailure', () => {
  it('treats a 412 personal-team miss as unavailable', () => {
    const result = classifyGrokBillingHttpFailure(
      412,
      JSON.stringify({
        code: "The system is not in a state required for the operation's execution",
        error: 'No personal team.'
      })
    )
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/team accounts/i)
    expect(result.error).not.toMatch(/HTTP 412/)
    expect(result.usageMetadata).toEqual({
      failureKind: 'usage-unavailable',
      source: 'oauth'
    })
  })

  it('keeps unexpected 412s as errors and includes the upstream detail', () => {
    expect(classifyGrokBillingHttpFailure(412, '{"error":"If-Match failed"}')).toEqual({
      status: 'error',
      error: 'Grok usage request failed (HTTP 412): If-Match failed'
    })
  })

  it('includes the upstream error on generic HTTP failures', () => {
    expect(classifyGrokBillingHttpFailure(500, '{"error":"Access denied"}')).toEqual({
      status: 'error',
      error: 'Grok usage request failed (HTTP 500): Access denied'
    })
  })

  it('falls back to the status-only message when the body has no error', () => {
    expect(classifyGrokBillingHttpFailure(502, '<html>nope</html>')).toEqual({
      status: 'error',
      error: 'Grok usage request failed (HTTP 502)'
    })
  })
})
