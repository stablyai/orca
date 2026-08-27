import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import {
  collectLiveAgyLogEndpoints,
  fetchAntigravityRateLimits,
  parseAgyLogEndpoint,
  parseAgyQuotaSummary,
  parseCsrfToken,
  parseLsofListeners
} from './antigravity-usage-fetcher'
import {
  deduplicateAgyQuotaEndpoints,
  inspectAgyProcessCommands
} from './antigravity-endpoint-selection'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response
}

const quotaSummary = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.9873386,
            resetTime: '2026-08-06T04:21:42Z'
          },
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.9240316,
            resetTime: '2026-07-30T12:25:31Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1 }
        ]
      }
    ]
  }
}

describe('Agy endpoint discovery parsers', () => {
  it('reads the live HTTP endpoint from an Agy CLI log', () => {
    expect(
      parseAgyLogEndpoint(`
I0730 16:55:25.550727 27262 server.go:1424] Starting language server process with pid 27262
I0730 16:55:25.554099 27262 server.go:568] Language server listening on random port at 50590 for HTTP
`)
    ).toEqual({ pid: 27262, port: 50590, csrfToken: null })
  })

  it('reads Agy and desktop language-server listeners from lsof fields', () => {
    expect(
      parseLsofListeners('p27262\ncagy\nn127.0.0.1:50590\np27451\nclanguage_\nn127.0.0.1:50610\n')
    ).toEqual([
      { pid: 27262, processName: 'agy', port: 50590 },
      { pid: 27451, processName: 'language_', port: 50610 }
    ])
  })

  it('reads both supported CSRF argument forms', () => {
    expect(parseCsrfToken('language_server --csrf_token abc-123 --standalone')).toBe('abc-123')
    expect(parseCsrfToken('language_server --csrf_token=def-456')).toBe('def-456')
  })

  it('keeps valid process commands when another process exits during inspection', async () => {
    const inspect = vi.fn(async (pid: number) => {
      if (pid === 27451) {
        throw new Error('process exited')
      }
      return `agy --pid ${pid}`
    })

    await expect(inspectAgyProcessCommands([27262, 27451], inspect)).resolves.toEqual(
      new Map([[27262, 'agy --pid 27262']])
    )
  })

  it('prefers a CSRF-authenticated duplicate endpoint', () => {
    expect(
      deduplicateAgyQuotaEndpoints([
        { pid: 27451, port: 50610, csrfToken: null },
        { pid: 27451, port: 50610, csrfToken: 'csrf-token' }
      ])
    ).toEqual([{ pid: 27451, port: 50610, csrfToken: 'csrf-token' }])
  })

  it('keeps valid log endpoints when another selected log disappears', async () => {
    const readLog = vi.fn(async (name: string) => {
      if (name === 'removed.log') {
        throw new Error('ENOENT')
      }
      return `
I0730 16:55:25.550727 27262 server.go:1424] Starting language server process with pid 27262
I0730 16:55:25.554099 27262 server.go:568] Language server listening on random port at 50590 for HTTP
`
    })

    await expect(
      collectLiveAgyLogEndpoints(['removed.log', 'active.log'], readLog, () => true)
    ).resolves.toEqual([{ pid: 27262, port: 50590, csrfToken: null }])
  })
})

describe('Agy quota summary', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('preserves both model groups and derives the tightest five-hour and weekly windows', () => {
    const windows = parseAgyQuotaSummary(quotaSummary)

    expect(windows?.session?.windowMinutes).toBe(300)
    expect(windows?.session?.usedPercent).toBeCloseTo(7.59684)
    expect(windows?.session?.resetsAt).toBe(Date.parse('2026-07-30T12:25:31Z'))
    expect(windows?.weekly?.windowMinutes).toBe(10_080)
    expect(windows?.weekly?.usedPercent).toBeCloseTo(1.26614)
    expect(windows?.buckets.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
      ['Gemini 5h', expect.closeTo(7.59684)],
      ['Gemini wk', expect.closeTo(1.26614)],
      ['Claude/GPT 5h', 0],
      ['Claude/GPT wk', 0]
    ])
  })

  it('does not synthesize fixed windows from unrelated model buckets', () => {
    expect(parseAgyQuotaSummary({ response: { groups: [] } })).toBeNull()
  })

  it('fetches the live Agy summary with its CSRF token', async () => {
    netFetchMock.mockResolvedValue(response(quotaSummary))

    const limits = await fetchAntigravityRateLimits(async () => [
      { pid: 27451, port: 50610, csrfToken: 'csrf-token' }
    ])

    expect(limits.status).toBe('ok')
    expect(limits.session?.windowMinutes).toBe(300)
    expect(limits.weekly?.windowMinutes).toBe(10_080)
    expect(limits.buckets).toHaveLength(4)
    expect(netFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('RetrieveUserQuotaSummary'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-codeium-csrf-token': 'csrf-token' })
      })
    )
  })

  it('tries the next Agy listener when the adjacent HTTPS port rejects HTTP', async () => {
    netFetchMock
      .mockRejectedValueOnce(new Error('Client sent an HTTP request to an HTTPS server'))
      .mockResolvedValueOnce(response(quotaSummary))

    const limits = await fetchAntigravityRateLimits(async () => [
      { pid: 27262, port: 50589, csrfToken: null },
      { pid: 27262, port: 50590, csrfToken: null }
    ])

    expect(limits.status).toBe('ok')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports unavailable when no Agy runtime is active', async () => {
    const limits = await fetchAntigravityRateLimits(async () => [])

    expect(limits.status).toBe('unavailable')
    expect(limits.error).toContain('not running')
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
