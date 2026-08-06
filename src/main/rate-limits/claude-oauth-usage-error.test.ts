import { describe, expect, it } from 'vitest'
import { createOAuthUsageError } from './claude-oauth-usage-error'

function rateLimitedResponse(headers?: Record<string, string>): Response {
  return new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers })
}

describe('createOAuthUsageError', () => {
  it('captures a numeric Retry-After on 429', async () => {
    const error = await createOAuthUsageError(rateLimitedResponse({ 'retry-after': '3037' }))
    expect(error.status).toBe(429)
    expect(error.skipPtyFallback).toBe(true)
    expect(error.retryAfterMs).toBe(3037 * 1000)
    expect(error.message).toBe('Claude usage is rate limited right now.')
  })

  it('captures an HTTP-date Retry-After on 429', async () => {
    const error = await createOAuthUsageError(
      rateLimitedResponse({ 'retry-after': new Date(Date.now() + 90_000).toUTCString() })
    )
    expect(error.retryAfterMs).toBeGreaterThan(0)
    expect(error.retryAfterMs).toBeLessThanOrEqual(90_000)
  })

  it('caps Retry-After at 24 hours', async () => {
    const error = await createOAuthUsageError(
      rateLimitedResponse({ 'retry-after': String(48 * 60 * 60) })
    )
    expect(error.retryAfterMs).toBe(24 * 60 * 60 * 1000)
  })

  it('ignores missing, invalid, and non-positive Retry-After values', async () => {
    for (const headers of [
      undefined,
      { 'retry-after': 'soon' },
      { 'retry-after': '0' },
      { 'retry-after': '-5' }
    ]) {
      const error = await createOAuthUsageError(rateLimitedResponse(headers))
      expect(error.retryAfterMs).toBeNull()
    }
  })

  it('does not capture Retry-After for non-429 responses', async () => {
    const error = await createOAuthUsageError(
      new Response('{"error":{"message":"Invalid token"}}', {
        status: 401,
        headers: { 'retry-after': '60' }
      })
    )
    expect(error.status).toBe(401)
    expect(error.retryAfterMs).toBeNull()
  })
})
