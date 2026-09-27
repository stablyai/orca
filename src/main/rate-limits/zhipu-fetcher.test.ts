import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchZhipuRateLimits } from './zhipu-fetcher'

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

function makeQuotaPayload(tokenPercent: number, toolPercent: number): unknown {
  return {
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', percentage: tokenPercent },
        { type: 'TIME_LIMIT', percentage: toolPercent }
      ]
    }
  }
}

describe('fetchZhipuRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'))
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns unavailable when auth token is empty', async () => {
    const result = await fetchZhipuRateLimits({ authToken: '' })

    expect(result.provider).toBe('zhipu')
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('fetches quota limits from the BigModel Anthropic base URL', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeQuotaPayload(37, 12)))

    const result = await fetchZhipuRateLimits({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authToken: 'zai-token'
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(37)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.monthly?.usedPercent).toBe(12)
    expect(result.monthly?.windowMinutes).toBe(43_200)
    expect(result.weekly).toBeNull()
    expect(result.usageMetadata?.authProvenance).toBe('Zhipu / open.bigmodel.cn')
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('zai-token')
    expect(init.headers.Accept).toBe('application/json')
  })

  it('supports the Z.AI Anthropic base URL', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeQuotaPayload(0, 99)))

    const result = await fetchZhipuRateLimits({
      baseUrl: 'https://api.z.ai/api/anthropic/',
      authToken: 'zai-token'
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(0)
    expect(result.monthly?.usedPercent).toBe(99)
    expect(netFetchMock.mock.calls[0][0]).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
  })

  it('classifies unauthorized responses as stale-token', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 401))

    const result = await fetchZhipuRateLimits({
      authToken: 'expired-token'
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.error).toMatch(/unauthorized/i)
  })

  it('classifies server responses as server failures', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 500))

    const result = await fetchZhipuRateLimits({
      authToken: 'zai-token'
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toContain('500')
  })

  it('classifies malformed JSON as parse failure', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      }
    } as unknown as Response)

    const result = await fetchZhipuRateLimits({
      authToken: 'zai-token'
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toContain('Unexpected token')
  })

  it('returns usage-unavailable when no quota windows are present', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({ data: { limits: [] } }))

    const result = await fetchZhipuRateLimits({
      authToken: 'zai-token'
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('does not send tokens to unsupported hosts', async () => {
    const result = await fetchZhipuRateLimits({
      baseUrl: 'https://example.com/api/anthropic',
      authToken: 'zai-token'
    })

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/unsupported zhipu usage host/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('does not send tokens to unsupported endpoint overrides', async () => {
    const result = await fetchZhipuRateLimits({
      authToken: 'zai-token',
      endpoint: 'https://example.com/api/monitor/usage/quota/limit'
    })

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/unsupported zhipu usage host/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
