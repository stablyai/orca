import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { discoverMock, httpsRequestMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  httpsRequestMock: vi.fn()
}))

// Why: mock at the same two module boundaries the fetcher itself crosses —
// process discovery and the local HTTPS transport — instead of spawning real
// processes or opening real sockets in unit tests.
vi.mock('./antigravity-process-discovery', () => ({
  discoverAntigravityRuntime: discoverMock
}))

vi.mock('node:https', () => ({
  request: httpsRequestMock
}))

import { fetchAntigravityRateLimits, parseAntigravityQuotaSummary } from './antigravity-fetcher'

type MockReq = EventEmitter & {
  write: (chunk: unknown) => void
  end: () => void
  destroy: () => void
}

function mockJsonResponse(statusCode: number, body: unknown): void {
  httpsRequestMock.mockImplementation(
    (_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const req = new EventEmitter() as MockReq
      req.write = vi.fn()
      req.end = vi.fn()
      req.destroy = vi.fn()
      const res = new EventEmitter() as EventEmitter & { statusCode: number }
      res.statusCode = statusCode
      callback(res)
      queueMicrotask(() => {
        res.emit(
          'data',
          Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
        )
        res.emit('end')
      })
      return req
    }
  )
}

function mockConnectionRefused(): void {
  httpsRequestMock.mockImplementation(() => {
    const req = new EventEmitter() as MockReq
    req.write = vi.fn()
    req.end = vi.fn()
    req.destroy = vi.fn()
    queueMicrotask(() => req.emit('error', new Error('ECONNREFUSED')))
    return req
  })
}

const REAL_QUOTA_SUMMARY_RESPONSE = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.93352824,
            resetTime: '2026-09-30T08:49:24Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-09-27T10:17:03Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 1,
            resetTime: '2026-10-04T05:53:29Z'
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-09-27T10:53:29Z'
          }
        ]
      }
    ],
    description: 'Within each group, models share a weekly limit and a 5-hour limit.'
  }
}

describe('parseAntigravityQuotaSummary', () => {
  it('parses the Gemini Models weekly bucket', () => {
    const buckets = parseAntigravityQuotaSummary(REAL_QUOTA_SUMMARY_RESPONSE)
    const geminiWeekly = buckets.find((b) => b.name === 'Gemini Weekly')
    expect(geminiWeekly).toMatchObject({
      usedPercent: 7,
      windowMinutes: 10_080
    })
    expect(geminiWeekly?.resetsAt).toBe(new Date('2026-09-30T08:49:24Z').getTime())
  })

  it('parses the Gemini Models five-hour bucket', () => {
    const buckets = parseAntigravityQuotaSummary(REAL_QUOTA_SUMMARY_RESPONSE)
    const geminiFiveHour = buckets.find((b) => b.name === 'Gemini 5h')
    expect(geminiFiveHour).toMatchObject({ usedPercent: 0, windowMinutes: 300 })
  })

  it('parses the Claude/GPT models weekly bucket', () => {
    const buckets = parseAntigravityQuotaSummary(REAL_QUOTA_SUMMARY_RESPONSE)
    const thirdPartyWeekly = buckets.find((b) => b.name === 'Claude/GPT Weekly')
    expect(thirdPartyWeekly).toMatchObject({ usedPercent: 0, windowMinutes: 10_080 })
  })

  it('parses the Claude/GPT models five-hour bucket', () => {
    const buckets = parseAntigravityQuotaSummary(REAL_QUOTA_SUMMARY_RESPONSE)
    const thirdPartyFiveHour = buckets.find((b) => b.name === 'Claude/GPT 5h')
    expect(thirdPartyFiveHour).toMatchObject({ usedPercent: 0, windowMinutes: 300 })
  })

  it('returns exactly four buckets for a complete response', () => {
    expect(parseAntigravityQuotaSummary(REAL_QUOTA_SUMMARY_RESPONSE)).toHaveLength(4)
  })

  it('skips a missing bucket instead of throwing', () => {
    const missingFiveHour = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.5,
                resetTime: '2026-09-30T08:49:24Z'
              }
              // gemini-5h intentionally absent
            ]
          }
        ]
      }
    }
    const buckets = parseAntigravityQuotaSummary(missingFiveHour)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.name).toBe('Gemini Weekly')
  })

  it('skips a bucket with a non-numeric remainingFraction instead of throwing', () => {
    const malformedBucket = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 'not-a-number' },
              {
                bucketId: 'gemini-5h',
                window: '5h',
                remainingFraction: 1,
                resetTime: 'garbage-date'
              }
            ]
          }
        ]
      }
    }
    const buckets = parseAntigravityQuotaSummary(malformedBucket)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.name).toBe('Gemini 5h')
    // Why: an unparsable reset timestamp must degrade to "no countdown", not throw.
    expect(buckets[0]?.resetsAt).toBeNull()
  })

  it('returns no buckets for a completely malformed response shape', () => {
    expect(parseAntigravityQuotaSummary({ unexpected: 'shape' })).toEqual([])
    expect(parseAntigravityQuotaSummary(null)).toEqual([])
    expect(parseAntigravityQuotaSummary('not even an object')).toEqual([])
    expect(parseAntigravityQuotaSummary(undefined)).toEqual([])
  })

  it('still parses a bucket whose window has already reset', () => {
    const alreadyReset = {
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                bucketId: '3p-weekly',
                window: 'weekly',
                remainingFraction: 1,
                resetTime: '2020-01-01T00:00:00Z'
              }
            ]
          }
        ]
      }
    }
    const buckets = parseAntigravityQuotaSummary(alreadyReset)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.resetsAt).toBe(new Date('2020-01-01T00:00:00Z').getTime())
  })

  it('classifies an unrecognized group name as the non-Gemini pool rather than dropping it', () => {
    const futureGroupName = {
      response: {
        groups: [
          {
            displayName: 'Some Future Model Family',
            buckets: [{ bucketId: 'future-5h', window: '5h', remainingFraction: 1 }]
          }
        ]
      }
    }
    const buckets = parseAntigravityQuotaSummary(futureGroupName)
    expect(buckets.map((b) => b.name)).toEqual(['Claude/GPT 5h'])
  })
})

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    discoverMock.mockReset()
    httpsRequestMock.mockReset()
  })

  it('reports unavailable (not an error) when Antigravity is not running', async () => {
    discoverMock.mockResolvedValue(null)
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(result.buckets).toBeUndefined()
  })

  it('fetches and parses real quota data end to end when Antigravity is running', async () => {
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51364] })
    mockJsonResponse(200, REAL_QUOTA_SUMMARY_RESPONSE)

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.buckets).toHaveLength(4)
    expect(result.buckets?.map((b) => b.name).sort()).toEqual(
      ['Claude/GPT 5h', 'Claude/GPT Weekly', 'Gemini 5h', 'Gemini Weekly'].sort()
    )
    // Why: the CSRF token authorizes the call, not TLS — verify it is sent.
    expect(httpsRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 51364,
        path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        headers: expect.objectContaining({ 'X-Codeium-Csrf-Token': 'token-abc' })
      }),
      expect.any(Function)
    )
  })

  it('falls back to the next candidate port when the first refuses the connection', async () => {
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51365, 51364] })
    let callCount = 0
    httpsRequestMock.mockImplementation(
      (
        options: { port: number },
        callback: (res: EventEmitter & { statusCode: number }) => void
      ) => {
        callCount += 1
        const req = new EventEmitter() as MockReq
        req.write = vi.fn()
        req.end = vi.fn()
        req.destroy = vi.fn()
        if (options.port === 51365) {
          queueMicrotask(() => req.emit('error', new Error('ECONNREFUSED')))
        } else {
          const res = new EventEmitter() as EventEmitter & { statusCode: number }
          res.statusCode = 200
          callback(res)
          queueMicrotask(() => {
            res.emit('data', Buffer.from(JSON.stringify(REAL_QUOTA_SUMMARY_RESPONSE)))
            res.emit('end')
          })
        }
        return req
      }
    )

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('ok')
    expect(callCount).toBe(2)
  })

  it('reports error (not unavailable) when the runtime is found but every request fails', async () => {
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51364] })
    mockConnectionRefused()

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('reports error when the runtime responds with a non-200 status', async () => {
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51364] })
    mockJsonResponse(500, '{}')

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toContain('500')
  })

  it('reports error when the response is valid JSON but has no usable buckets (malformed shape)', async () => {
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51364] })
    mockJsonResponse(200, { response: { groups: [] } })

    const result = await fetchAntigravityRateLimits()

    expect(result.status).toBe('error')
  })

  it('never depends on Gemini state or credentials (provider isolation)', async () => {
    // Why: the fetcher's only dependencies are process discovery and the local
    // HTTPS transport — asserting that is a structural guard against #9122/
    // #19561 regressing (Antigravity silently re-coupling to the Gemini fetch).
    discoverMock.mockResolvedValue({ pid: 123, csrfToken: 'token-abc', ports: [51364] })
    mockJsonResponse(200, REAL_QUOTA_SUMMARY_RESPONSE)

    const result = await fetchAntigravityRateLimits()

    expect(result.provider).toBe('antigravity')
    expect(Object.keys(result)).not.toContain('geminiProjectId')
    expect(discoverMock).toHaveBeenCalledTimes(1)
  })
})
