import { describe, expect, it } from 'vitest'
import {
  GROK_ACCESS_TOKEN_REFRESH_LEAD_MS,
  GROK_ACCESS_TOKEN_SKEW_MS,
  grokAccessTokenNeedsCliRefresh,
  grokAccessTokenRefreshDelayMs,
  isGrokAccessTokenFreshAt
} from './grok-auth-expiry'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')

describe('grok access token expiry', () => {
  it('treats a missing expiry as still usable', () => {
    expect(isGrokAccessTokenFreshAt(null, NOW)).toBe(true)
    expect(grokAccessTokenRefreshDelayMs(null, NOW)).toBeNull()
    expect(grokAccessTokenNeedsCliRefresh(null, NOW)).toBe(false)
  })

  it('asks for a CLI refresh once the token enters the early-invalidation window', () => {
    const insideLead = NOW + GROK_ACCESS_TOKEN_REFRESH_LEAD_MS - 1
    expect(grokAccessTokenNeedsCliRefresh(insideLead, NOW)).toBe(true)
    expect(isGrokAccessTokenFreshAt(insideLead, NOW)).toBe(false)
    expect(grokAccessTokenRefreshDelayMs(insideLead, NOW)).toBe(-1)
  })

  it('waits until the lead window when the token is still fresh', () => {
    const expiresAt = NOW + GROK_ACCESS_TOKEN_REFRESH_LEAD_MS + 5_000
    expect(grokAccessTokenNeedsCliRefresh(expiresAt, NOW)).toBe(false)
    expect(grokAccessTokenRefreshDelayMs(expiresAt, NOW)).toBe(5_000)
  })

  it('treats the skew window as expired for billing', () => {
    const expiresAt = NOW + GROK_ACCESS_TOKEN_SKEW_MS
    expect(isGrokAccessTokenFreshAt(expiresAt, NOW)).toBe(false)
    expect(grokAccessTokenNeedsCliRefresh(expiresAt, NOW)).toBe(true)
  })
})
