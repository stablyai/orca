import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted<{ files: Map<string, string | Error> }>(() => ({
  files: new Map()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const entry = fsState.files.get(String(path))
    if (entry === undefined) {
      const error = new Error(
        `ENOENT: no such file or directory, open ${path}`
      ) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    if (entry instanceof Error) {
      throw entry
    }
    return entry
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchZaiRateLimits } from './zai-fetcher'

const AUTH_PATH = join('/home/test', '.local', 'share', 'opencode', 'auth.json')
const QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'

function writeAuthJson(value: unknown): void {
  fsState.files.set(AUTH_PATH, JSON.stringify(value))
}

function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  } as Response
}

// Real shape from GET https://api.z.ai/api/monitor/usage/quota/limit: a 5h
// window (unit 3 × 5) plus a weekly window (unit 6 × 1), percentage quotas
// with epoch-ms reset times.
const WRAPPED_QUOTA = {
  success: true,
  data: {
    limits: [
      {
        type: 'CREDIT_LIMIT',
        percentage: 62.5,
        unit: 3,
        number: 5,
        nextResetTime: 1770648402389
      },
      {
        type: 'CREDIT_LIMIT',
        percentage: 10,
        unit: 6,
        number: 1,
        nextResetTime: 1771000000000
      }
    ]
  }
}

describe('fetchZaiRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    fsState.files.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable and never fetches without a key', async () => {
    const result = await fetchZaiRateLimits()
    expect(result.provider).toBe('zai')
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.source).toBe('web')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps the wrapped payload to exact 300/10080 windows with raw-key headers', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(jsonResponse(WRAPPED_QUOTA))

    const result = await fetchZaiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.usageMetadata?.source).toBe('web')
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBeCloseTo(62.5)
    expect(result.session?.resetsAt).toBe(1770648402389)
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.weekly?.usedPercent).toBeCloseTo(10)

    // Why: exactly one usage request per fetch — no retries, no extra probes.
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe(QUOTA_URL)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Authorization: 'key-abc',
      'Accept-Language': 'en-US,en',
      'Content-Type': 'application/json'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('combines an optional caller signal with the bounded timeout', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    let captured: AbortSignal | undefined
    netFetchMock.mockImplementationOnce(async (_url: string, init: { signal: AbortSignal }) => {
      captured = init.signal
      return jsonResponse(WRAPPED_QUOTA)
    })

    const controller = new AbortController()
    const result = await fetchZaiRateLimits({ signal: controller.signal })

    expect(result.status).toBe('ok')
    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured?.aborted).toBe(false)
    // Why: the composite signal must propagate caller cancellation.
    controller.abort()
    expect(captured?.aborted).toBe(true)
  })

  it('parses the unwrapped payload with legacy TOKENS_LIMIT name field', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        limits: [{ name: 'TOKENS_LIMIT', percentage: '41', unit: 3, number: 5 }]
      })
    )

    const result = await fetchZaiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBeCloseTo(41)
    expect(result.weekly).toBeNull()
  })

  it('converts epoch-second resets and clamps percentages', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        limits: [
          { type: 'CREDIT_LIMIT', percentage: 150, unit: 3, number: 5, nextResetTime: 1770648402 },
          { type: 'CREDIT_LIMIT', percentage: -4, unit: 6, number: 1 }
        ]
      })
    )

    const result = await fetchZaiRateLimits()

    expect(result.session?.usedPercent).toBe(100)
    expect(result.session?.resetsAt).toBe(1770648402000)
    expect(result.weekly?.usedPercent).toBe(0)
    expect(result.weekly?.resetsAt).toBeNull()
  })

  it('accepts only exact 5-hour and 7-day windows', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        limits: [
          { type: 'CREDIT_LIMIT', percentage: 80, unit: 4, number: 3 },
          { type: 'CREDIT_LIMIT', percentage: 20, unit: 3, number: 5 },
          { type: 'CREDIT_LIMIT', percentage: 5, unit: 4, number: 10 },
          { type: 'CREDIT_LIMIT', percentage: 40, unit: 4, number: 7 }
        ]
      })
    )

    const result = await fetchZaiRateLimits()

    expect(result.session?.usedPercent).toBeCloseTo(20)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.usedPercent).toBeCloseTo(40)
    expect(result.weekly?.windowMinutes).toBe(10080)
  })

  it('ignores unrelated and unusable entries', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        limits: [
          { type: 'TIME_LIMIT', percentage: 50, currentValue: 1, usage: 100 },
          { type: 'CREDIT_LIMIT', unit: 3, number: 5 }, // no percentage
          { type: 'CREDIT_LIMIT', percentage: 30, unit: 9, number: 5 }, // unknown unit
          'garbage'
        ]
      })
    )

    const result = await fetchZaiRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.source).toBe('web')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('uses the record-provided origin only when it is allowed', async () => {
    writeAuthJson({
      'zai-coding-plan': {
        type: 'api',
        key: 'key-abc',
        metadata: { baseURL: 'https://open.bigmodel.cn/api/anthropic' }
      }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse(WRAPPED_QUOTA))
    await fetchZaiRateLimits()
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock.mock.calls[0][0]).toBe(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
    )

    writeAuthJson({
      'zai-coding-plan': {
        type: 'api',
        key: 'key-abc',
        metadata: { baseURL: 'https://evil.example.com/api/anthropic' }
      }
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse(WRAPPED_QUOTA))
    await fetchZaiRateLimits()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(netFetchMock.mock.calls[1][0]).toBe(QUOTA_URL)
  })

  it('classifies 401/403 as stale credentials without leaking the key', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'secret-key-abc' } })
    for (const status of [401, 403]) {
      netFetchMock.mockResolvedValueOnce(jsonResponse({}, { status }))
      const result = await fetchZaiRateLimits()
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('stale-token')
      expect(result.error).toContain(`HTTP ${status}`)
      expect(result.error).not.toContain('secret-key-abc')
    }
  })

  it('captures a numeric Retry-After on 429', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3000' } })
    )
    const before = Date.now()
    const result = await fetchZaiRateLimits()
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3000 * 1000)
    expect(result.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 3000 * 1000)
  })

  it('omits retryAtMs for missing, invalid, and non-positive Retry-After', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    for (const header of [null, 'soon', '0']) {
      netFetchMock.mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: header ? { 'retry-after': header } : {} })
      )
      const result = await fetchZaiRateLimits()
      expect(result.usageMetadata?.failureKind).toBe('rate-limited')
      expect(result.usageMetadata?.retryAtMs).toBeUndefined()
    }
  })

  it('classifies 5xx as a server failure', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
    const result = await fetchZaiRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
  })

  it('classifies malformed JSON bodies as a parse failure', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      }
    } as unknown as Response)
    const result = await fetchZaiRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('classifies payload shape problems as usage-unavailable', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    for (const body of ['not-an-object', {}, { limits: 'nope' }, { data: {} }]) {
      netFetchMock.mockResolvedValueOnce(jsonResponse(body))
      const result = await fetchZaiRateLimits()
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    }
  })

  it('reports request failures as a generic sanitized network error', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'secret-key-abc' } })
    netFetchMock.mockRejectedValueOnce(
      new Error('fetch failed: https://api.z.ai/... internal ECONNRESET detail')
    )
    const result = await fetchZaiRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toBe('Z.ai usage request failed — check your network connection')
    expect(result.error).not.toContain('secret-key-abc')
    expect(result.error).not.toContain('ECONNRESET')
  })

  it('reports timeout aborts as bounded network errors', async () => {
    writeAuthJson({ 'zai-coding-plan': { type: 'api', key: 'key-abc' } })
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    netFetchMock.mockRejectedValueOnce(timeout)
    const result = await fetchZaiRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toContain('timed out')
  })
})
