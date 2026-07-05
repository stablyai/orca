import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { clearStorageDataMock, cookiesSetMock, netFetchMock, sessionFromPartitionMock } = vi.hoisted(
  () => {
    const netFetchMock = vi.fn()
    const cookiesSetMock = vi.fn(() => Promise.resolve())
    const clearStorageDataMock = vi.fn(() => Promise.resolve())
    const sessionFromPartitionMock = vi.fn(() => ({
      clearStorageData: clearStorageDataMock,
      cookies: { set: cookiesSetMock },
      fetch: netFetchMock
    }))
    return { clearStorageDataMock, cookiesSetMock, netFetchMock, sessionFromPartitionMock }
  }
)

vi.mock('electron', () => ({
  net: { fetch: netFetchMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import {
  extractMiniMaxCookieValue,
  fetchMiniMaxRateLimits,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret
} from './minimax-fetcher'

const MINIMAX_URL = 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains'

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

function makeOkPayload(remainingPercent: number): unknown {
  const now = Date.now()
  return {
    base_resp: { status_code: 0, status_msg: 'ok' },
    model_remains: [
      {
        model_name: 'general',
        current_interval_remaining_percent: remainingPercent,
        start_time: now - 60_000,
        end_time: now + 5 * 60 * 60 * 1000,
        remains_time: 5 * 60 * 60 * 1000
      }
    ]
  }
}

const FULL_COOKIE =
  '_token=eyJh.eyJ.payload; _twpid=tw.123; minimax_group_id_v2=12345; platform_cookie_consent=3'

function getCookieJarSetNames(): string[] {
  return cookiesSetMock.mock.calls.map((call) => {
    const [details] = call as unknown as [{ name: string }]
    return details.name
  })
}

describe('fetchMiniMaxRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'))
    clearStorageDataMock.mockClear()
    cookiesSetMock.mockClear()
    netFetchMock.mockReset()
    sessionFromPartitionMock.mockClear()
    sessionFromPartitionMock.mockImplementation(() => ({
      clearStorageData: clearStorageDataMock,
      cookies: { set: cookiesSetMock },
      fetch: netFetchMock
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns unavailable when cookie is empty', async () => {
    const result = await fetchMiniMaxRateLimits({ cookie: '' })
    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('minimax')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toMatch(/not configured/i)
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when cookie is only whitespace', async () => {
    const result = await fetchMiniMaxRateLimits({ cookie: '   ' })
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('returns error when cookie has no _token', async () => {
    const result = await fetchMiniMaxRateLimits({
      cookie: '_twpid=tw.123; minimax_group_id_v2=12345'
    })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/MiniMax auth cookie not found/)
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('classifies 401 as stale-token', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 401))
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.error).toMatch(/session expired/i)
  })

  it('classifies 403 as stale-token', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 403))
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('classifies 500 as server', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 500))
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toMatch(/500/)
  })

  it('returns ok with session window mapping remaining to usedPercent', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(35)))
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('minimax')
    expect(result.session?.usedPercent).toBe(65)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly).toBeNull()
  })

  it('reports a fixed 5-hour session window regardless of API interval drift', async () => {
    const startTime = 1_700_000_000_000
    const endTime = startTime + 295 * 60_000
    netFetchMock.mockResolvedValueOnce(
      makeResponse({
        base_resp: { status_code: 0, status_msg: 'ok' },
        model_remains: [
          {
            model_name: 'general',
            current_interval_remaining_percent: 60,
            start_time: startTime,
            end_time: endTime,
            remains_time: endTime - startTime
          }
        ]
      })
    )
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('ok')
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.resetsAt).toBe(endTime)
  })

  it('does not derive the windowMinutes label from the raw start/end interval', async () => {
    const startTime = 1_700_000_000_000
    const endTime = startTime + 4 * 60 * 60_000
    netFetchMock.mockResolvedValueOnce(
      makeResponse({
        base_resp: { status_code: 0, status_msg: 'ok' },
        model_remains: [
          {
            model_name: 'general',
            current_interval_remaining_percent: 63,
            start_time: startTime,
            end_time: endTime,
            remains_time: endTime - startTime
          }
        ]
      })
    )
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('ok')
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBe(37)
    expect(result.session?.resetsAt).toBe(endTime)
  })

  it('sets the cookie jar and sends browser-like request headers', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(80)))
    await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(sessionFromPartitionMock).toHaveBeenCalledWith('orca-minimax-rate-limit-fetch')
    expect(clearStorageDataMock).toHaveBeenCalledWith({
      origin: 'https://platform.minimax.io',
      storages: ['cookies']
    })
    expect(getCookieJarSetNames()).toEqual([
      '_token',
      '_twpid',
      'minimax_group_id_v2',
      'platform_cookie_consent'
    ])
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe(MINIMAX_URL)
    expect(init.method).toBe('GET')
    expect(init.headers.Cookie).toBeUndefined()
    expect(init.headers['X-Group-Id']).toBe('12345')
    expect(init.headers.Referer).toBe('https://platform.minimax.io/console/usage')
    expect(init.headers.Accept).toMatch(/application\/json/)
    expect(init.headers['Accept-Language']).toBe('en-US,en;q=0.9')
    expect(init.headers['Sec-Fetch-Dest']).toBeUndefined()
    expect(init.headers['Sec-Fetch-Mode']).toBeUndefined()
    expect(init.headers['Sec-Fetch-Site']).toBeUndefined()
    expect(init.headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
    expect(init.headers['User-Agent']).not.toContain('orca-minimax-usage')
  })

  it('accepts quoted MiniMax cookie storage syntax', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(80)))
    await fetchMiniMaxRateLimits({
      cookie: '_token:"jwt-token" minimax_group_id_v2:"42"'
    })
    const [, init] = netFetchMock.mock.calls[0]
    expect(getCookieJarSetNames()).toEqual(['_token', 'minimax_group_id_v2'])
    expect(init.headers.Cookie).toBeUndefined()
    expect(init.headers['X-Group-Id']).toBe('42')
  })

  it('preserves the complete browser Cookie header', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(80)))
    const fullBrowserCookie = [
      'platform_cookie_consent=3',
      '_ga=analytics',
      '_token=tok',
      '_twpid=tw.1',
      'ak_bmsc=ak',
      'bm_sv=sv',
      'bm_sz=sz',
      '_abck=ab',
      'minimax_group_id_v2=42',
      'sensorsdata2015jssdkcross=analytics'
    ].join('; ')
    await fetchMiniMaxRateLimits({
      cookie: fullBrowserCookie
    })
    const [, init] = netFetchMock.mock.calls[0]
    expect(getCookieJarSetNames()).toEqual([
      'platform_cookie_consent',
      '_ga',
      '_token',
      '_twpid',
      'ak_bmsc',
      'bm_sv',
      'bm_sz',
      '_abck',
      'minimax_group_id_v2',
      'sensorsdata2015jssdkcross'
    ])
    expect(init.headers.Cookie).toBeUndefined()
  })

  it('prefers explicit groupId over cookie value', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(80)))
    await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE, groupId: 'override-id' })
    expect(netFetchMock.mock.calls[0][1].headers['X-Group-Id']).toBe('override-id')
  })

  it('falls back to cookie minimax_group_id_v2 when groupId is empty', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(80)))
    await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE, groupId: '' })
    expect(netFetchMock.mock.calls[0][1].headers['X-Group-Id']).toBe('12345')
  })

  it('surfaces base_resp status_code != 0 as usage-unavailable', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ base_resp: { status_code: 401, status_msg: 'unauth' } })
    )
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('unauth')
  })

  it('returns error when model_remains is empty', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ base_resp: { status_code: 0 }, model_remains: [] })
    )
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toMatch(/configured model was not found/i)
  })

  it('returns error when configured model is not in response', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ base_resp: { status_code: 0 }, model_remains: [] })
    )
    const result = await fetchMiniMaxRateLimits({
      cookie: FULL_COOKIE,
      models: 'unrelated-model'
    })
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/configured model was not found/i)
  })

  it('falls back to the lone snapshot when no configured model matches', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(makeOkPayload(40)))
    const result = await fetchMiniMaxRateLimits({
      cookie: FULL_COOKIE,
      models: 'unrelated-model'
    })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(60)
  })

  it('selects the first configured model when multiple are listed', async () => {
    const payload = makeOkPayload(40)
    ;(payload as { model_remains: unknown[] }).model_remains = [
      {
        model_name: 'unrelated',
        current_interval_remaining_percent: 10,
        start_time: Date.now() - 60_000,
        end_time: Date.now() + 5 * 60 * 60 * 1000,
        remains_time: 5 * 60 * 60 * 1000
      },
      {
        model_name: 'general',
        current_interval_remaining_percent: 40,
        start_time: Date.now() - 60_000,
        end_time: Date.now() + 5 * 60 * 60 * 1000,
        remains_time: 5 * 60 * 60 * 1000
      }
    ]
    netFetchMock.mockResolvedValueOnce(makeResponse(payload))
    const result = await fetchMiniMaxRateLimits({
      cookie: FULL_COOKIE,
      models: 'general'
    })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(60)
  })

  it('redacts _token in any error path that includes payload text', async () => {
    const payload = { base_resp: { status_code: 7, status_msg: FULL_COOKIE } }
    netFetchMock.mockResolvedValueOnce(makeResponse(payload))
    const result = await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(result.error).not.toContain('eyJh')
    expect(result.error).not.toContain('minimax_group_id_v2=12345')
    expect(result.error).toContain('[REDACTED]')
  })

  it('logs MiniMax failures with cookie names but without cookie values', async () => {
    const warn = vi.mocked(console.warn)
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ base_resp: { status_code: 7, status_msg: FULL_COOKIE } })
    )
    await fetchMiniMaxRateLimits({ cookie: FULL_COOKIE })
    expect(warn).toHaveBeenCalledWith(
      '[minimax] usage fetch failed',
      expect.objectContaining({
        baseRespStatusMsg: expect.not.stringContaining('eyJh'),
        cookieNames: ['_token', '_twpid', 'minimax_group_id_v2', 'platform_cookie_consent']
      })
    )
  })
})

describe('normalizeMiniMaxCookieHeader', () => {
  it('preserves all cookie pairs from a browser Cookie header', () => {
    const normalized = normalizeMiniMaxCookieHeader(
      '_token=tok; session=other; ak_bmsc=ak; minimax_group_id_v2=42; random=xyz'
    )
    expect(normalized).toBe(
      '_token=tok; session=other; ak_bmsc=ak; minimax_group_id_v2=42; random=xyz'
    )
  })

  it('normalizes quoted MiniMax cookie storage syntax', () => {
    expect(normalizeMiniMaxCookieHeader('_token:"tok" minimax_group_id_v2:"42"')).toBe(
      '_token=tok; minimax_group_id_v2=42'
    )
  })

  it('accepts a copied Cookie header line', () => {
    expect(normalizeMiniMaxCookieHeader('Cookie: session=abc; other=xyz')).toBe(
      'session=abc; other=xyz'
    )
  })
})

describe('extractMiniMaxCookieValue', () => {
  it('returns the value for a given cookie name', () => {
    expect(extractMiniMaxCookieValue(FULL_COOKIE, 'minimax_group_id_v2')).toBe('12345')
  })
  it('returns null when the name is absent', () => {
    expect(extractMiniMaxCookieValue('_token=tok', 'minimax_group_id_v2')).toBeNull()
  })
})

describe('redactMiniMaxSecret', () => {
  it('redacts _token values', () => {
    expect(redactMiniMaxSecret('cookie _token=eyJhABCDEF')).toContain('_token=[REDACTED]')
    expect(redactMiniMaxSecret('cookie _token=eyJhABCDEF')).not.toContain('eyJhABCDEF')
  })
  it('redacts minimax_group_id_v2 values', () => {
    expect(redactMiniMaxSecret('minimax_group_id_v2=99999 trailing')).not.toContain('99999')
  })
  it('redacts MiniMax anti-bot cookie values', () => {
    const redacted = redactMiniMaxSecret('ak_bmsc=secret bm_sv:"secret2"')
    expect(redacted).not.toContain('secret')
    expect(redacted).toContain('ak_bmsc=[REDACTED]')
    expect(redacted).toContain('bm_sv:[REDACTED]')
  })
  it('redacts Cookie: header lines', () => {
    expect(redactMiniMaxSecret('X-Cookie: _token=secret')).toContain('[REDACTED]')
  })
})
