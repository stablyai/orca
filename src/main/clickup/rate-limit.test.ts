import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireClickUpRequestToken,
  CLICKUP_MAX_RATE_LIMIT_RETRIES,
  clickUpRetryDelayMs,
  getClickUpRateLimitState,
  noteClickUpRateLimitHeaders,
  onClickUpRateLimitStateChange,
  resetClickUpRateLimitStateForTests,
  sendWithClickUpRateLimitRetry,
  type ClickUpRateLimitState
} from './rate-limit'

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers })
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('clickUpRetryDelayMs', () => {
  it('prefers Retry-After seconds', () => {
    expect(
      clickUpRetryDelayMs(new Headers({ 'retry-after': '7', 'x-ratelimit-reset': '9' }), 0, NOW)
    ).toBe(7_000)
  })

  it('falls back to the epoch-seconds X-RateLimit-Reset with padding', () => {
    const reset = String(NOW / 1000 + 12)
    expect(clickUpRetryDelayMs(new Headers({ 'x-ratelimit-reset': reset }), 0, NOW)).toBe(12_250)
  })

  it('uses capped, jittered exponential backoff without headers', () => {
    expect(clickUpRetryDelayMs(new Headers(), 0, NOW, () => 0)).toBe(1_000)
    expect(clickUpRetryDelayMs(new Headers(), 2, NOW, () => 0)).toBe(4_000)
    expect(clickUpRetryDelayMs(new Headers(), 2, NOW, () => 1)).toBe(5_000)
    expect(clickUpRetryDelayMs(new Headers(), 20, NOW, () => 0)).toBe(65_000)
  })

  it('caps hostile reset values to one rate-limit window', () => {
    expect(clickUpRetryDelayMs(new Headers({ 'retry-after': '86400' }), 0, NOW)).toBe(65_000)
    const farReset = String(NOW / 1000 + 86_400)
    expect(clickUpRetryDelayMs(new Headers({ 'x-ratelimit-reset': farReset }), 0, NOW)).toBe(65_000)
  })
})

describe('ClickUp request limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetClickUpRateLimitStateForTests()
  })

  afterEach(() => {
    resetClickUpRateLimitStateForTests()
    vi.useRealTimers()
  })

  it('spends bucket tokens and paces once they run out', async () => {
    resetClickUpRateLimitStateForTests(2)
    await acquireClickUpRequestToken()
    await acquireClickUpRequestToken()

    const third = acquireClickUpRequestToken()
    expect(await settled(third)).toBe(false)
    // Two per minute refills one token every 30s.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await settled(third)).toBe(true)
  })

  it('resizes the bucket to 80% of the X-RateLimit-Limit the server reports', async () => {
    resetClickUpRateLimitStateForTests(1)
    noteClickUpRateLimitHeaders(new Headers({ 'x-ratelimit-limit': '1000' }))
    // The new capacity refills at 800/minute, so a drained bucket recovers in 75ms.
    await acquireClickUpRequestToken()
    const next = acquireClickUpRequestToken()
    await vi.advanceTimersByTimeAsync(75)
    expect(await settled(next)).toBe(true)
  })

  it('trusts X-RateLimit-Remaining over its own count', async () => {
    noteClickUpRateLimitHeaders(new Headers({ 'x-ratelimit-remaining': '5' }))
    await acquireClickUpRequestToken()
    await acquireClickUpRequestToken()
    // Remaining 5 minus a safety margin of 3 leaves two tokens.
    expect(await settled(acquireClickUpRequestToken())).toBe(false)
  })

  it('pauses every request until the reset once the budget is nearly spent', async () => {
    const reset = String(NOW / 1000 + 5)
    noteClickUpRateLimitHeaders(
      new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': reset })
    )
    expect(getClickUpRateLimitState()).toEqual({ pausedUntil: NOW + 5_250, rateLimited: false })

    const waiting = acquireClickUpRequestToken()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await settled(waiting)).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(await settled(waiting)).toBe(true)
  })

  it('retries a 429 after the Retry-After delay and reports the pause', async () => {
    const states: ClickUpRateLimitState[] = []
    onClickUpRateLimitStateChange((state) => states.push(state))
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(response(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(200))

    const pending = sendWithClickUpRateLimitRetry(send)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(send).toHaveBeenCalledTimes(1)
    expect(states[0]).toEqual({ pausedUntil: NOW + 2_000, rateLimited: true })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await pending).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toEqual({ pausedUntil: null, rateLimited: false })
  })

  it('waits for the X-RateLimit-Reset on 429 instead of hammering', async () => {
    const reset = String(NOW / 1000 + 10)
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(response(429, { 'x-ratelimit-reset': reset }))
      .mockResolvedValueOnce(response(200))

    const pending = sendWithClickUpRateLimitRetry(send)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).status).toBe(200)
  })

  it('gives up after the retry cap and returns the 429', async () => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => response(429, { 'retry-after': '1' }))

    const pending = sendWithClickUpRateLimitRetry(send)
    await vi.advanceTimersByTimeAsync(20_000)

    expect((await pending).status).toBe(429)
    expect(send).toHaveBeenCalledTimes(CLICKUP_MAX_RATE_LIMIT_RETRIES + 1)
  })

  it('does not retry other failures', async () => {
    const send = vi.fn<() => Promise<Response>>().mockResolvedValue(response(500))

    expect((await sendWithClickUpRateLimitRetry(send)).status).toBe(500)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController()
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(response(429, { 'retry-after': '30' }))

    const pending = sendWithClickUpRateLimitRetry(send, controller.signal)
    const assertion = expect(pending).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(new Error('cancelled'))
    await assertion
    expect(send).toHaveBeenCalledTimes(1)
  })
})
