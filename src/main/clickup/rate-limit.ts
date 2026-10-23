import type { ClickUpRateLimitState } from '../../shared/clickup-types'
import { parseRetryAfterHeaderMs } from '../../shared/retry-after-header'

export type { ClickUpRateLimitState }

// Why one limiter for every ClickUp call: the budget belongs to the token
// (100 requests/minute on most plans), and the task page, composer search,
// create dialog, CLI and RPC all spend it. Pacing here keeps them under the
// limit together instead of each feature tripping 429 on its own.
export const CLICKUP_MAX_RATE_LIMIT_RETRIES = 3
// Why 80: stays ~20% under the common 100/minute limit so other clients of the
// same token (the ClickUp web app, scripts) keep some headroom.
const DEFAULT_REQUESTS_PER_MINUTE = 80
const MINUTE_MS = 60_000
// Why: one ClickUp window is a minute; a longer wait means a hostile or broken
// header, so the request fails instead of hanging the UI.
const MAX_RATE_LIMIT_WAIT_MS = 65_000
const BASE_BACKOFF_MS = 1_000
// Why: the reset header has second precision, so pad it to land after the window.
const RESET_PADDING_MS = 250
// Why: when only a few calls remain in the window, pause until the reset
// instead of spending them on guaranteed 429s.
const LOW_REMAINING_THRESHOLD = 3

type BucketState = {
  capacity: number
  tokens: number
  lastRefillMs: number
  blockedUntilMs: number
  rateLimited: boolean
}

let bucket: BucketState = freshBucket(DEFAULT_REQUESTS_PER_MINUTE)
const stateListeners = new Set<(state: ClickUpRateLimitState) => void>()
let lastPublished: ClickUpRateLimitState = { pausedUntil: null, rateLimited: false }

function freshBucket(capacity: number, nowMs = Date.now()): BucketState {
  return { capacity, tokens: capacity, lastRefillMs: nowMs, blockedUntilMs: 0, rateLimited: false }
}

function refill(nowMs: number): void {
  const elapsed = Math.max(0, nowMs - bucket.lastRefillMs)
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed * bucket.capacity) / MINUTE_MS)
  bucket.lastRefillMs = nowMs
}

function publish(nowMs = Date.now()): void {
  const paused = bucket.blockedUntilMs > nowMs
  const next: ClickUpRateLimitState = {
    pausedUntil: paused ? bucket.blockedUntilMs : null,
    rateLimited: paused && bucket.rateLimited
  }
  if (
    next.pausedUntil === lastPublished.pausedUntil &&
    next.rateLimited === lastPublished.rateLimited
  ) {
    return
  }
  lastPublished = next
  for (const listener of stateListeners) {
    listener(next)
  }
}

export function onClickUpRateLimitStateChange(
  listener: (state: ClickUpRateLimitState) => void
): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function getClickUpRateLimitState(nowMs = Date.now()): ClickUpRateLimitState {
  const paused = bucket.blockedUntilMs > nowMs
  return {
    pausedUntil: paused ? bucket.blockedUntilMs : null,
    rateLimited: paused && bucket.rateLimited
  }
}

let clearTimer: ReturnType<typeof setTimeout> | null = null

function blockUntil(untilMs: number, rateLimited: boolean): void {
  if (untilMs > bucket.blockedUntilMs) {
    bucket.blockedUntilMs = untilMs
    bucket.rateLimited = rateLimited
  }
  publish()
  // Why: the UI shows the pause until it ends, even when no request follows.
  if (clearTimer) {
    clearTimeout(clearTimer)
  }
  clearTimer = setTimeout(() => publish(), Math.max(0, bucket.blockedUntilMs - Date.now()) + 50)
  clearTimer.unref?.()
}

function parseResetDelayMs(value: string | null, nowMs: number): number | null {
  if (!value) {
    return null
  }
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) {
    return null
  }
  // ClickUp sends epoch seconds; accept epoch milliseconds defensively.
  const resetMs = raw > 1e12 ? raw : raw * 1_000
  const delayMs = resetMs - nowMs + RESET_PADDING_MS
  return delayMs > 0 ? Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.ceil(delayMs)) : null
}

export function clickUpRetryDelayMs(
  headers: Headers,
  attempt: number,
  nowMs = Date.now(),
  random: () => number = Math.random
): number {
  const retryAfter = parseRetryAfterHeaderMs(
    headers.get('retry-after'),
    MAX_RATE_LIMIT_WAIT_MS,
    nowMs
  )
  if (retryAfter !== null) {
    return retryAfter
  }
  const reset = parseResetDelayMs(headers.get('x-ratelimit-reset'), nowMs)
  if (reset !== null) {
    return reset
  }
  // Jitter keeps parallel retries from landing in the same instant.
  const backoff = BASE_BACKOFF_MS * 2 ** attempt
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.round(backoff * (1 + random() * 0.25)))
}

// Adapts the bucket to the budget a response reports: a different plan limit
// resizes it, a low remaining count shrinks it, and an empty one pauses
// every request until the reset.
export function noteClickUpRateLimitHeaders(headers: Headers, nowMs = Date.now()): void {
  const limit = Number(headers.get('x-ratelimit-limit'))
  if (headers.has('x-ratelimit-limit') && Number.isFinite(limit) && limit > 0) {
    const capacity = Math.max(1, Math.floor(limit * 0.8))
    if (capacity !== bucket.capacity) {
      refill(nowMs)
      bucket.capacity = capacity
      bucket.tokens = Math.min(bucket.tokens, capacity)
    }
  }
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  if (!headers.has('x-ratelimit-remaining') || !Number.isFinite(remaining)) {
    return
  }
  refill(nowMs)
  // Why: other clients of the token spend the same budget, so never believe we
  // have more than the server says is left.
  bucket.tokens = Math.min(bucket.tokens, Math.max(0, remaining - LOW_REMAINING_THRESHOLD))
  if (remaining <= LOW_REMAINING_THRESHOLD) {
    const delayMs = parseResetDelayMs(headers.get('x-ratelimit-reset'), nowMs)
    if (delayMs !== null) {
      blockUntil(nowMs + delayMs, false)
    }
  }
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Waits for any pause, then for a bucket token, and spends it.
export async function acquireClickUpRequestToken(signal?: AbortSignal | null): Promise<void> {
  for (;;) {
    const nowMs = Date.now()
    if (bucket.blockedUntilMs > nowMs) {
      await sleepUnlessAborted(bucket.blockedUntilMs - nowMs, signal)
      continue
    }
    publish(nowMs)
    refill(nowMs)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return
    }
    const waitMs = Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / bucket.capacity)
    await sleepUnlessAborted(waitMs, signal)
  }
}

// Sends a request through the shared bucket, retrying 429s after the server's
// reset (or jittered exponential backoff) up to CLICKUP_MAX_RATE_LIMIT_RETRIES.
export async function sendWithClickUpRateLimitRetry(
  send: () => Promise<Response>,
  signal?: AbortSignal | null
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    await acquireClickUpRequestToken(signal)
    const response = await send()
    if (response.status !== 429) {
      noteClickUpRateLimitHeaders(response.headers)
      return response
    }
    const delayMs = clickUpRetryDelayMs(response.headers, attempt)
    // Why: every queued request shares the token's budget, so pause them all
    // and drop the bucket so pacing restarts slowly after the reset.
    blockUntil(Date.now() + delayMs, true)
    bucket.tokens = 0
    if (attempt >= CLICKUP_MAX_RATE_LIMIT_RETRIES) {
      return response
    }
    // Drain the body so the connection can be reused while we wait.
    await response.body?.cancel().catch(() => undefined)
  }
}

export function resetClickUpRateLimitStateForTests(requestsPerMinute?: number): void {
  bucket = freshBucket(requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE)
  lastPublished = { pausedUntil: null, rateLimited: false }
  stateListeners.clear()
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
}
