import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

type MockJsonResponse = Pick<Response, 'ok' | 'status' | 'json'>

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchZaiRateLimits } from './zai-fetcher'

function makeResponse(body: unknown, status = 200): MockJsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

function makeJsonThrowingResponse(error: Error, status = 200): MockJsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw error
    }
  }
}

function makeQuotaPayload(entries: unknown[]): unknown {
  return {
    code: 200,
    success: true,
    data: {
      limits: entries
    }
  }
}

function makeRealisticPayload(): unknown {
  return {
    code: 200,
    success: true,
    data: {
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          number: 5,
          percentage: 35,
          nextResetTime: 1_784_199_600_000
        },
        {
          type: 'TOKENS_LIMIT',
          unit: 6,
          number: 1,
          percentage: 70,
          nextResetTime: '1784505600000'
        },
        {
          type: 'TIME_LIMIT',
          unit: 5,
          number: 1,
          percentage: 91,
          nextResetTime: 1_785_628_800_000
        }
      ]
    }
  }
}

describe('fetchZaiRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('returns unavailable when the API key is missing', async () => {
    const result = await fetchZaiRateLimits({ apiKey: '   ' })
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('sends the exact Authorization header without a Bearer prefix', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeQuotaPayload([{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 }]))
    )
    await fetchZaiRateLimits({ apiKey: 'glm-key' })
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'glm-key' })
      })
    )
    expect(netFetchMock.mock.calls[0][1].headers.Authorization).not.toContain('Bearer')
  })

  it('parses realistic data.limits entries with type and exact numeric reset epochs', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeRealisticPayload()))

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('ok')
    expect(result.session).toEqual({
      usedPercent: 35,
      windowMinutes: 300,
      resetsAt: 1_784_199_600_000,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 70,
      windowMinutes: 10080,
      resetsAt: 1_784_505_600_000,
      resetDescription: null
    })
    expect(result.monthly).toEqual({
      usedPercent: 91,
      windowMinutes: 43200,
      resetsAt: 1_785_628_800_000,
      resetDescription: null
    })
  })

  it('does not fail when weekly and monthly windows are omitted', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeQuotaPayload([
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 120, nextResetTime: null }
        ])
      )
    )

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(100)
    expect(result.weekly).toBeNull()
    expect(result.monthly).toBeNull()
  })

  it('uses a null reset time when monthly nextResetTime is absent', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeQuotaPayload([
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 40 }
        ])
      )
    )

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('ok')
    expect(result.monthly?.resetsAt).toBeNull()
  })

  it('treats a missing 5-hour window as usage-unavailable', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeQuotaPayload([{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 20 }]))
    )

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('5-hour token quota window')
  })

  it('accepts code 200 with data.limits even when success is absent', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({
        code: 200,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: 12345 }
          ]
        }
      })
    )

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('ok')
    expect(result.session?.resetsAt).toBe(12345)
  })

  it.each([
    [401, 'stale-token'],
    [403, 'stale-token'],
    [429, 'rate-limited'],
    [500, 'server']
  ] as const)('maps HTTP %s to %s', async (status, failureKind) => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, status))
    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe(failureKind)
  })

  it('redacts invalid JSON parser errors', async () => {
    const leakedApiKey = 'glm-secret-key'
    netFetchMock.mockResolvedValueOnce(
      makeJsonThrowingResponse(new SyntaxError(`Unexpected token near ${leakedApiKey}`))
    )

    const result = await fetchZaiRateLimits({ apiKey: leakedApiKey })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toBe('Invalid Z.ai usage response')
    expect(result.error).not.toContain(leakedApiKey)
  })

  it('aborts the request when the caller aborts', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    netFetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    })

    const resultPromise = fetchZaiRateLimits({ apiKey: 'glm-key', signal: controller.signal })
    await Promise.resolve()

    expect(requestSignal).not.toBe(controller.signal)
    expect(requestSignal?.aborted).toBe(false)
    controller.abort()
    expect(requestSignal?.aborted).toBe(true)

    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it.each([null, 42, 'oops'])('maps non-object JSON payload %j to parse failures', async (body) => {
    netFetchMock.mockResolvedValueOnce(makeResponse(body))

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('maps unsuccessful payloads to usage-unavailable', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ success: false, message: 'quota unavailable' })
    )

    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toBe('Z.ai usage data is currently unavailable')
  })

  it('never propagates the remote usage-unavailable message to renderer state', async () => {
    const leakedApiKey = 'glm-secret-key'
    netFetchMock.mockResolvedValueOnce(
      makeResponse({
        success: false,
        message: `remote error for ${leakedApiKey}`,
        msg: leakedApiKey
      })
    )

    const result = await fetchZaiRateLimits({ apiKey: leakedApiKey })

    expect(result.status).toBe('error')
    expect(result.error).toBe('Z.ai usage data is currently unavailable')
    expect(result.error).not.toContain(leakedApiKey)
  })

  it('maps network failures to network', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))
    const result = await fetchZaiRateLimits({ apiKey: 'glm-key' })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })
})
