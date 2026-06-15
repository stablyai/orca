import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchZaiRateLimits, mapZaiQuotaResponse } from './zai-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const SAMPLE_QUOTA_RESPONSE = {
  code: 200,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 16, nextResetTime: 1777819631597 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 4, nextResetTime: 1778262784969 },
      { type: 'TIME_LIMIT', unit: 5, percentage: 0, nextResetTime: 1780336384978 }
    ]
  }
}

describe('Z.AI rate limit fetcher', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('maps the quota response to session, weekly, and monthly windows', () => {
    const result = mapZaiQuotaResponse(SAMPLE_QUOTA_RESPONSE)

    expect(result.provider).toBe('zai')
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(16)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.usedPercent).toBe(4)
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.monthly?.usedPercent).toBe(0)
    expect(result.monthly?.windowMinutes).toBe(43200)
  })

  it('clamps quota percentages to the supported display range', () => {
    const result = mapZaiQuotaResponse({
      code: 200,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: -12, nextResetTime: null },
          { type: 'TOKENS_LIMIT', unit: 6, percentage: 140, nextResetTime: null }
        ]
      }
    })

    expect(result.session?.usedPercent).toBe(0)
    expect(result.weekly?.usedPercent).toBe(100)
  })

  it('returns unavailable when no Z.AI API key is configured', async () => {
    const result = await fetchZaiRateLimits(null)

    expect(result.status).toBe('unavailable')
    expect(result.error).toBe('No Z.AI API key configured')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns an authorization error for unauthorized quota requests', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, 401))

    const result = await fetchZaiRateLimits('token-1')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Z.AI usage request unauthorized. Check your API key.')
  })

  it('returns an error when the quota response has no known windows', () => {
    const result = mapZaiQuotaResponse({ code: 200, data: { limits: [] } })

    expect(result.status).toBe('error')
    expect(result.error).toBe('Z.AI usage response did not include quota windows')
  })
})
