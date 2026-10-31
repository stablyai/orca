// Grok CLI reuses cached tokens until its five-minute early-invalidation window.
export const GROK_ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1000
export const GROK_ACCESS_TOKEN_REFRESH_LEAD_MS = GROK_ACCESS_TOKEN_SKEW_MS

export function isGrokAccessTokenFreshAt(expiresAtMs: number | null, now = Date.now()): boolean {
  if (expiresAtMs === null) {
    // Missing expiry is inconclusive; the billing endpoint can still reject the token.
    return true
  }
  return expiresAtMs - now > GROK_ACCESS_TOKEN_SKEW_MS
}

/** Milliseconds until a `grok sessions list` refresh should run, or null when expiry is unknown. */
export function grokAccessTokenRefreshDelayMs(
  expiresAtMs: number | null,
  now = Date.now()
): number | null {
  if (expiresAtMs === null) {
    return null
  }
  return expiresAtMs - now - GROK_ACCESS_TOKEN_REFRESH_LEAD_MS
}

export function grokAccessTokenNeedsCliRefresh(
  expiresAtMs: number | null,
  now = Date.now()
): boolean {
  const delay = grokAccessTokenRefreshDelayMs(expiresAtMs, now)
  return delay !== null && delay <= 0
}
