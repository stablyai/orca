import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAntigravityAuthCache,
  parseAntigravityToken,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET
} from './antigravity-auth'
import { parseQuotaResponse, fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

const { readFileMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

/**
 * Builds a JSON response for mocked Electron network requests.
 * @param data Response body.
 * @param status HTTP status code.
 * @returns A JSON response with the requested status.
 */
const mockResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

describe('parseAntigravityToken', () => {
  it('parses number and ISO string token.expiry correctly', () => {
    const rawNum = { token: { access_token: 't1', expiry: 1700000000000 } }
    const rawIso = { token: { access_token: 't2', expiry: '2026-04-24T13:00:00.000Z' } }
    expect(parseAntigravityToken(rawNum)?.expiry_date).toBe(1700000000000)
    expect(parseAntigravityToken(rawIso)?.expiry_date).toBe(Date.parse('2026-04-24T13:00:00.000Z'))
  })
})

describe('parseQuotaResponse', () => {
  it('parses four exact buckets and ignores unknown bucketId', () => {
    const raw = {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              remainingFraction: 0.9,
              resetTime: '2026-04-24T13:00:00.000Z',
              bucketId: 'gemini-5h'
            },
            {
              remainingFraction: 0.95,
              resetTime: '2026-04-28T13:00:00.000Z',
              bucketId: 'gemini-weekly'
            }
          ]
        },
        {
          name: 'Claude and GPT',
          buckets: [
            { remainingFraction: 0.8, resetTime: '2026-04-24T13:00:00.000Z', bucketId: '3p-5h' },
            {
              remainingFraction: 0.85,
              resetTime: '2026-04-28T13:00:00.000Z',
              bucketId: '3p-weekly'
            },
            {
              remainingFraction: 0.5,
              resetTime: '2026-04-24T13:00:00.000Z',
              bucketId: 'unknown-bucket-x'
            }
          ]
        }
      ]
    }
    const parsed = parseQuotaResponse(raw)
    expect(parsed).toHaveLength(4)
    expect(parsed[0]).toMatchObject({ name: 'Gemini 5h', usedPercent: 10, windowMinutes: 300 })
    expect(parsed[1]).toMatchObject({ name: 'Gemini weekly', usedPercent: 5, windowMinutes: 10080 })
    expect(parsed[2]).toMatchObject({ name: 'Claude/GPT 5h', usedPercent: 20, windowMinutes: 300 })
    expect(parsed[3]).toMatchObject({
      name: 'Claude/GPT weekly',
      usedPercent: 15,
      windowMinutes: 10080
    })
  })
})

describe('fetchAntigravityRateLimits MVP orchestration', () => {
  beforeEach(() => {
    clearAntigravityAuthCache()
    readFileMock.mockReset()
    netFetchMock.mockReset()
    readFileMock.mockRejectedValue({ code: 'ENOENT' })
  })

  it('renders all four buckets for UI consumers with correct windowMinutes', async () => {
    readFileMock.mockImplementation(async () =>
      JSON.stringify({ access_token: 'valid-tok', refresh_token: 'ref-tok' })
    )

    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(mockResponse({ cloudaicompanionProject: 'proj-123' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(
          mockResponse({
            groups: [
              {
                buckets: [
                  {
                    remainingFraction: 0.9,
                    resetTime: '2026-04-24T13:00:00.000Z',
                    bucketId: 'gemini-5h'
                  },
                  {
                    remainingFraction: 0.95,
                    resetTime: '2026-04-28T13:00:00.000Z',
                    bucketId: 'gemini-weekly'
                  },
                  {
                    remainingFraction: 0.8,
                    resetTime: '2026-04-24T13:00:00.000Z',
                    bucketId: '3p-5h'
                  },
                  {
                    remainingFraction: 0.85,
                    resetTime: '2026-04-28T13:00:00.000Z',
                    bucketId: '3p-weekly'
                  }
                ]
              }
            ]
          })
        )
      }
      return Promise.resolve(mockResponse({}, 404))
    })

    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(4)
    expect(result.session).not.toBeNull()
    expect(result.weekly).not.toBeNull()
  })

  it('retries once when loadCodeAssist returns 401, verifying OpenUsage OAuth client/secret', async () => {
    let loadAttempts = 0
    readFileMock.mockImplementation(async () =>
      JSON.stringify({ access_token: 'stale-tok', refresh_token: 'ref-tok-1' })
    )

    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('token')) {
        return Promise.resolve(mockResponse({ access_token: 'new-tok-1', expires_in: 3600 }))
      }
      if (url.includes('loadCodeAssist')) {
        loadAttempts += 1
        if (loadAttempts === 1) {
          return Promise.resolve(mockResponse({}, 401))
        }
        return Promise.resolve(mockResponse({ cloudaicompanionProject: 'retry-proj' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(mockResponse({ groups: [] }))
      }
      return Promise.resolve(mockResponse({}, 404))
    })

    const result = await fetchAntigravityRateLimits(true)
    expect(result.status).toBe('ok')
    expect(loadAttempts).toBe(2)
    expect(netFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('token'),
      expect.objectContaining({
        body: expect.stringContaining(`client_id=${ANTIGRAVITY_CLIENT_ID}`)
      })
    )
    expect(netFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('token'),
      expect.objectContaining({
        body: expect.stringContaining(`client_secret=${ANTIGRAVITY_CLIENT_SECRET}`)
      })
    )
  })

  it('does not repeat refresh on second poll cycle within expiry', async () => {
    let refreshCalls = 0
    readFileMock.mockImplementation(async () =>
      JSON.stringify({
        access_token: 'exp-tok',
        refresh_token: 'ref-tok-2',
        expiry: Date.now() - 1000
      })
    )

    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('token')) {
        refreshCalls += 1
        return Promise.resolve(mockResponse({ access_token: 'refreshed-tok-2', expires_in: 3600 }))
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(mockResponse({ cloudaicompanionProject: 'proj-2' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(mockResponse({ groups: [] }))
      }
      return Promise.resolve(mockResponse({}, 404))
    })

    await fetchAntigravityRateLimits(true)
    await fetchAntigravityRateLimits(true)
    expect(refreshCalls).toBe(1)
  })

  it('invalidates memory cache when account switches to a different refresh_token', async () => {
    let refreshCalls = 0
    readFileMock
      .mockImplementationOnce(async () =>
        JSON.stringify({
          access_token: 'exp-tok-1',
          refresh_token: 'acc-1-ref',
          expiry: Date.now() - 1000
        })
      )
      .mockImplementationOnce(async () =>
        JSON.stringify({
          access_token: 'exp-tok-2',
          refresh_token: 'acc-2-ref',
          expiry: Date.now() - 1000
        })
      )

    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('token')) {
        refreshCalls += 1
        return Promise.resolve(
          mockResponse({ access_token: `refreshed-tok-${refreshCalls}`, expires_in: 3600 })
        )
      }
      if (url.includes('loadCodeAssist')) {
        return Promise.resolve(mockResponse({ cloudaicompanionProject: 'proj-acc' }))
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return Promise.resolve(mockResponse({ groups: [] }))
      }
      return Promise.resolve(mockResponse({}, 404))
    })

    await fetchAntigravityRateLimits(true)
    await fetchAntigravityRateLimits(true)
    expect(refreshCalls).toBe(2)
  })
})
