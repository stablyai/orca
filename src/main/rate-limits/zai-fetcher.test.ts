import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchZaiRateLimits, ZAI_USAGE_ENDPOINT } from './zai-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

// Real shape captured from GET https://api.z.ai/api/monitor/usage/quota/limit
// on a GLM Coding Plan "pro" subscription.
const QUOTA_RESPONSE = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    limits: [
      {
        type: 'CREDIT_LIMIT',
        unit: 3,
        number: 5,
        usage: 12000,
        currentValue: 839,
        remaining: 11160,
        percentage: 6,
        nextResetTime: 1788469936870
      },
      {
        type: 'CREDIT_LIMIT',
        unit: 6,
        number: 1,
        usage: 60000,
        currentValue: 44392,
        remaining: 15607,
        percentage: 73,
        nextResetTime: 1788520473997
      }
    ],
    level: 'pro'
  }
}

describe('fetchZaiRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('maps the 5-hour and weekly quota windows', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    const result = await fetchZaiRateLimits({ apiKey: 'key-1' })
    expect(result.status).toBe('ok')
    expect(result.planType).toBe('pro')
    expect(result.session).toEqual({
      usedPercent: 6,
      windowMinutes: 300,
      resetsAt: 1788469936870,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 73,
      windowMinutes: 10080,
      resetsAt: 1788520473997,
      resetDescription: null
    })
  })

  it('sends the raw key — z.ai rejects a Bearer-prefixed Authorization header', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    await fetchZaiRateLimits({ apiKey: '  key-2  ' })
    expect(netFetchMock).toHaveBeenCalledWith(
      ZAI_USAGE_ENDPOINT,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'key-2' }) })
    )
  })

  it('reports an unconfigured key as unavailable, not an error', async () => {
    const result = await fetchZaiRateLimits({ apiKey: '   ' })
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats a rejected key as a stale token', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}, 401))
    const result = await fetchZaiRateLimits({ apiKey: 'key-3' })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('surfaces a payload-level failure message', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({ success: false, msg: 'quota service down' }))
    const result = await fetchZaiRateLimits({ apiKey: 'key-4' })
    expect(result.status).toBe('error')
    expect(result.error).toBe('quota service down')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  it('aborts with the caller signal instead of waiting out the request timeout', async () => {
    netFetchMock.mockResolvedValue(jsonResponse(QUOTA_RESPONSE))
    const controller = new AbortController()
    await fetchZaiRateLimits({ apiKey: 'key-6', signal: controller.signal })
    const passedSignal = netFetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(passedSignal.aborted).toBe(false)
    controller.abort()
    expect(passedSignal.aborted).toBe(true)
  })

  it('ignores windows whose unit code is unknown', async () => {
    netFetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { level: 'lite', limits: [{ unit: 99, number: 5, percentage: 10 }] }
      })
    )
    const result = await fetchZaiRateLimits({ apiKey: 'key-5' })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })
})
