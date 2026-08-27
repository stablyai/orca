import { afterEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchGlmRateLimits } from './glm-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const QUOTA_RESPONSE = {
  success: true,
  data: {
    limits: [
      {
        type: 'CREDIT_LIMIT',
        unit: 3,
        number: 5,
        percentage: 25,
        nextResetTime: 1_700_000_000_000
      },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 50, nextResetTime: 1_800_000_000_000 }
    ],
    level: 'pro'
  }
}

describe('fetchGlmRateLimits', () => {
  afterEach(() => {
    netFetchMock.mockReset()
  })

  it('returns unavailable for empty apiKey', async () => {
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: '' })
    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('glm')
  })

  it('maps 5h and weekly windows from ZAI platform', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(25)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.usedPercent).toBe(50)
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.planType).toBe('pro')
    expect(result.error).toBeNull()
  })

  it('maps legacy TOKENS_LIMIT payloads', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20 }
          ]
        }
      })
    )
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.weekly?.usedPercent).toBe(20)
  })

  it('ignores non-quota limit types (TIME_LIMIT)', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          limits: [
            { type: 'TIME_LIMIT', unit: 3, percentage: 99 },
            { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 30 }
          ]
        }
      })
    )
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(30)
  })

  it('uses Zhipu base URL for zhipu platform', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    await fetchGlmRateLimits({ platform: 'zhipu', apiKey: 'tok-abc' })

    const url: string = netFetchMock.mock.calls[0][0]
    expect(url).toContain('open.bigmodel.cn')
  })

  it('uses ZAI base URL for zai platform', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    const url: string = netFetchMock.mock.calls[0][0]
    expect(url).toContain('api.z.ai')
  })

  it('sends Bearer token in Authorization header', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    const headers: Record<string, string> = netFetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer tok-abc')
  })

  it('returns error on 401', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, 401))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('error')
    expect(result.error).toContain('401')
  })

  it('returns error on 403', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, 403))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('error')
    expect(result.error).toContain('403')
  })

  it('returns error on non-ok status', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, 500))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('error')
    expect(result.error).toContain('500')
  })

  it('returns error when no matching windows found', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({ success: true, data: { limits: [] } }))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('error')
    expect(result.error).toContain('did not include quota windows')
  })

  it('returns error on network error', async () => {
    netFetchMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('error')
  })

  it('handles missing optional fields gracefully', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 10 }] }
      })
    )
    const result = await fetchGlmRateLimits({ platform: 'zai', apiKey: 'tok-abc' })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.session?.resetsAt).toBeNull()
  })
})
