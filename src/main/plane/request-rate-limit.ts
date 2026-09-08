import { createHash } from 'node:crypto'

/**
 * Plane allows 60 requests per minute per API key and advertises
 * `X-RateLimit-Remaining` / `X-RateLimit-Reset`. Spending the last request
 * before the window resets earns a 429 for every caller, so the budget is
 * tracked per workspace and the next request waits instead.
 */

const WINDOW_MS = 60_000
const MAX_WAIT_MS = 60_000

const throttledUntilByBudget = new Map<string, number>()

/**
 * Plane's 60/minute allowance is per API key, so state is keyed by a digest of
 * the token rather than by workspace. Keying by workspace let one token
 * connected to two workspaces spend the allowance twice and earn 429s for both.
 * The raw token is never used as a key or logged.
 */
export function rateLimitBudgetKey(apiToken: string): string {
  return createHash('sha256').update(apiToken).digest('base64url').slice(0, 16)
}

export function getThrottleWaitMs(budgetKey: string, now = Date.now()): number {
  const until = throttledUntilByBudget.get(budgetKey)
  if (until === undefined) {
    return 0
  }
  if (until <= now) {
    throttledUntilByBudget.delete(budgetKey)
    return 0
  }
  return Math.min(until - now, MAX_WAIT_MS)
}

/** Records the advertised budget. Only an exhausted budget parks the workspace. */
export function noteRateLimitHeaders(
  budgetKey: string,
  headers: { get(name: string): string | null },
  now = Date.now()
): void {
  // Absent headers mean the deployment does not advertise a budget -- not that
  // the budget is zero. Number(null) is 0, so the null check must come first.
  const remaining = readNumericHeader(headers, 'x-ratelimit-remaining')
  if (remaining === null || remaining > 0) {
    return
  }
  parkBudget(budgetKey, resetAt(headers.get('x-ratelimit-reset'), now), now)
}

/** A 429 is authoritative even when the budget headers are absent. */
export function noteRateLimited(
  budgetKey: string,
  headers: { get(name: string): string | null },
  now = Date.now()
): number {
  const retryAfter = readNumericHeader(headers, 'retry-after')
  const until =
    retryAfter === null
      ? resetAt(headers.get('x-ratelimit-reset'), now)
      : now + Math.max(0, retryAfter) * 1000
  parkBudget(budgetKey, until, now)
  return getThrottleWaitMs(budgetKey, now)
}

export function resetRateLimitState(): void {
  throttledUntilByBudget.clear()
}

function readNumericHeader(
  headers: { get(name: string): string | null },
  name: string
): number | null {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parkBudget(budgetKey: string, until: number, now = Date.now()): void {
  // Why: an instance reporting the reset in milliseconds (or a huge
  // Retry-After) would park a token years out. Callers only ever wait
  // MAX_WAIT_MS, so storing more than that guarantees admission gives up
  // instead of the budget clearing. Clamp the stored value to what a caller
  // can actually observe.
  const bounded = Math.min(until, now + MAX_WAIT_MS)
  const current = throttledUntilByBudget.get(budgetKey) ?? 0
  throttledUntilByBudget.set(budgetKey, Math.max(current, bounded))
}

// Plane sends a unix timestamp in seconds; tolerate instances that report a
// relative number of seconds instead, and fall back to a full window.
function resetAt(headerValue: string | null, now: number): number {
  const reset = Number(headerValue)
  if (!Number.isFinite(reset) || reset <= 0) {
    return now + WINDOW_MS
  }
  return reset > 1e9 ? reset * 1000 : now + reset * 1000
}
