import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCommandCodeRateLimits } from './command-code-fetcher'

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn()
  }
}))

import { net } from 'electron'

const netFetchMock = vi.mocked(net.fetch)

afterEach(() => {
  netFetchMock.mockReset()
})

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as Response
}

const VALID_CREDITS_RESPONSE = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 28.912,
    purchasedCredits: 0,
    premiumMonthlyCredits: 15,
    opensourceMonthlyCredits: 13.912
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 1.088,
      cap: 9,
      exceeded: false,
      resetAt: 1783956990513
    },
    weekly: {
      used: 1.088,
      cap: 18,
      exceeded: false,
      resetAt: 1784543790513
    }
  }
}

const VALID_SUBSCRIPTION_RESPONSE = {
  success: true,
  data: {
    id: 'sub_test',
    status: 'active',
    planId: 'individual-pro',
    currentPeriodEnd: '2026-08-08T16:23:59.000Z'
  }
}

describe('fetchCommandCodeRateLimits', () => {
  it('returns unavailable when cookie is empty', async () => {
    const result = await fetchCommandCodeRateLimits({ cookieHeader: '' })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('cookie')
  })

  it('returns unavailable when cookie is only whitespace', async () => {
    const result = await fetchCommandCodeRateLimits({ cookieHeader: '   ' })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('cookie')
  })

  it('returns error when credits endpoint fails', async () => {
    netFetchMock.mockResolvedValueOnce(mockResponse(401, { error: 'unauthorized' }))

    const result = await fetchCommandCodeRateLimits({ cookieHeader: 'token=abc' })
    expect(result.status).toBe('error')
    expect(result.error).toContain('credits request failed')
  })

  it('returns ok with session, weekly, and monthly windows for a Pro plan', async () => {
    netFetchMock
      .mockResolvedValueOnce(mockResponse(200, VALID_CREDITS_RESPONSE))
      .mockResolvedValueOnce(mockResponse(200, VALID_SUBSCRIPTION_RESPONSE))

    const result = await fetchCommandCodeRateLimits({
      cookieHeader:
        '__Secure-commandcode_prod_.session_token=token; __Secure-commandcode_prod_.session_data=data'
    })

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.provider).toBe('command-code')

    // Session window (5-hour)
    expect(result.session).not.toBeNull()
    expect(result.session!.usedPercent).toBe(12) // 1.088 / 9 * 100
    expect(result.session!.windowMinutes).toBe(300)

    // Weekly window
    expect(result.weekly).not.toBeNull()
    expect(result.weekly!.usedPercent).toBe(6) // 1.088 / 18 * 100
    expect(result.weekly!.windowMinutes).toBe(10080)

    // Monthly window — uses subscription plan total (30 USD) when available
    expect(result.monthly).not.toBeNull()
    expect(result.monthly!.usedPercent).toBe(4) // (30 - 28.912) / 30 * 100
    expect(result.monthly!.windowMinutes).toBe(43200)

    // Auth provenance
    expect(result.usageMetadata?.authProvenance).toContain('Pro')
    expect(result.usageMetadata?.source).toBe('web')
  })

  it('handles missing subscription data gracefully', async () => {
    netFetchMock
      .mockResolvedValueOnce(mockResponse(200, VALID_CREDITS_RESPONSE))
      .mockRejectedValueOnce(new Error('timeout'))

    const result = await fetchCommandCodeRateLimits({
      cookieHeader:
        '__Secure-commandcode_prod_.session_token=token; __Secure-commandcode_prod_.session_data=data'
    })

    // Should still return ok with window data from credits
    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()
    expect(result.weekly).not.toBeNull()
    // Falls back to credits data (premium 15 + opensource 13.912 = 28.912)
    expect(result.monthly).not.toBeNull()
    // remaining 28.912 out of 28.912 = 0% used
    expect(result.monthly!.usedPercent).toBe(0)
  })

  it('handles network errors', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('Network failure'))

    const result = await fetchCommandCodeRateLimits({
      cookieHeader:
        '__Secure-commandcode_prod_.session_token=token; __Secure-commandcode_prod_.session_data=data'
    })

    expect(result.status).toBe('error')
    expect(result.error).toContain('Network failure')
  })

  it('accepts Cookie:-prefixed headers', async () => {
    netFetchMock
      .mockResolvedValueOnce(mockResponse(200, VALID_CREDITS_RESPONSE))
      .mockResolvedValueOnce(mockResponse(200, VALID_SUBSCRIPTION_RESPONSE))

    const result = await fetchCommandCodeRateLimits({
      cookieHeader:
        'Cookie: __Secure-commandcode_prod_.session_token=token; __Secure-commandcode_prod_.session_data=data'
    })

    expect(result.status).toBe('ok')
  })
})
