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
  fetchMiniMaxWithManualCookieHeader,
  fetchMiniMaxWithSessionCookieJar,
  getUniqueMiniMaxCookieNames,
  logMiniMaxFetchFailure,
  makeMiniMaxRequestHeaders,
  MINIMAX_USAGE_ENDPOINT,
  normalizeMiniMaxCookieHeader,
  redactMiniMaxSecret
} from './minimax-request-context'

const FULL_COOKIE =
  '_token=eyJh.eyJ.payload; _twpid=tw.123; minimax_group_id_v2=12345; platform_cookie_consent=3'

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

  it('accepts a copied Cookie header line with prefix', () => {
    expect(normalizeMiniMaxCookieHeader('Cookie: session=abc; other=xyz')).toBe(
      'session=abc; other=xyz'
    )
  })

  it('merges header and quoted forms without dropping any pair', () => {
    const mixed = '_token=header-quoted _twpid:"q-1"; minimax_group_id_v2=42'
    const normalized = normalizeMiniMaxCookieHeader(mixed)
    expect(normalized).toContain('_token=header-quoted')
    expect(normalized).toContain('_twpid=q-1')
    expect(normalized).toContain('minimax_group_id_v2=42')
  })
})

describe('extractMiniMaxCookieValue', () => {
  it('returns the value for a known name', () => {
    expect(extractMiniMaxCookieValue(FULL_COOKIE, '_token')).toBe('eyJh.eyJ.payload')
  })

  it('returns null when the name is absent', () => {
    expect(extractMiniMaxCookieValue('_token=tok', 'minimax_group_id_v2')).toBeNull()
  })

  it('handles Chromium quoted syntax', () => {
    expect(
      extractMiniMaxCookieValue('_token:"jwt" minimax_group_id_v2:"42"', 'minimax_group_id_v2')
    ).toBe('42')
  })
})

describe('getUniqueMiniMaxCookieNames', () => {
  it('deduplicates repeated names', () => {
    const names = getUniqueMiniMaxCookieNames(
      '_token=a; _token=b; minimax_group_id_v2=42; minimax_group_id_v2=99'
    )
    expect(names).toEqual(['_token', 'minimax_group_id_v2'])
  })

  it('returns names from a quoted-only Cookie storage export', () => {
    const names = getUniqueMiniMaxCookieNames(
      '_token:"jwt" minimax_group_id_v2:"42" platform_cookie_consent:"3"'
    )
    expect(names).toEqual(
      expect.arrayContaining(['_token', 'minimax_group_id_v2', 'platform_cookie_consent'])
    )
  })
})

describe('redactMiniMaxSecret', () => {
  it('redacts _token values in header and quoted syntax', () => {
    const redacted = redactMiniMaxSecret('cookie _token=eyJhABCDEF and _token:"x.y"')
    expect(redacted).toContain('_token=[REDACTED]')
    expect(redacted).not.toContain('eyJhABCDEF')
    expect(redacted).not.toContain('x.y')
  })

  it('redacts minimax_group_id_v2', () => {
    expect(redactMiniMaxSecret('minimax_group_id_v2=99999 trailing')).not.toContain('99999')
  })

  it('redacts MiniMax anti-bot cookie values', () => {
    const redacted = redactMiniMaxSecret('ak_bmsc=zzzsecret bm_sv:"yyyvalue" _abck="xxxdata"')
    expect(redacted).not.toContain('zzzsecret')
    expect(redacted).not.toContain('yyyvalue')
    expect(redacted).not.toContain('xxxdata')
    expect(redacted).toContain('ak_bmsc=[REDACTED]')
    expect(redacted).toContain('bm_sv:[REDACTED]')
    expect(redacted).toContain('_abck=[REDACTED]')
  })

  it('redacts full Cookie: header lines', () => {
    const redacted = redactMiniMaxSecret('Header line\nCookie: _token=secret\nFooter')
    expect(redacted).toContain('Cookie: [REDACTED]')
    expect(redacted).not.toContain('Cookie: _token=secret')
  })
})

describe('makeMiniMaxRequestHeaders', () => {
  it('always includes browser-like Accept, Accept-Language, Referer, and User-Agent', () => {
    const headers = makeMiniMaxRequestHeaders(null)
    expect(headers.Accept).toMatch(/application\/json/)
    expect(headers['Accept-Language']).toBe('en-US,en;q=0.9')
    expect(headers.Referer).toBe('https://platform.minimax.io/console/usage')
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
    expect(headers['User-Agent']).not.toContain('orca-minimax-usage')
  })

  it('omits X-Group-Id when groupId is null', () => {
    const headers = makeMiniMaxRequestHeaders(null)
    expect(headers['X-Group-Id']).toBeUndefined()
  })

  it('omits X-Group-Id when groupId is empty string', () => {
    const headers = makeMiniMaxRequestHeaders('')
    expect(headers['X-Group-Id']).toBeUndefined()
  })

  it('includes X-Group-Id when groupId is provided', () => {
    const headers = makeMiniMaxRequestHeaders('2034972027806299092')
    expect(headers['X-Group-Id']).toBe('2034972027806299092')
  })
})

describe('fetchMiniMaxWithSessionCookieJar', () => {
  beforeEach(() => {
    clearStorageDataMock.mockClear()
    cookiesSetMock.mockClear()
    netFetchMock.mockReset()
    sessionFromPartitionMock.mockClear()
    sessionFromPartitionMock.mockImplementation(() => ({
      clearStorageData: clearStorageDataMock,
      cookies: { set: cookiesSetMock },
      fetch: netFetchMock
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses a dedicated MiniMax partition and clears cookies before fetching', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [] })
    })
    const controller = new AbortController()
    await fetchMiniMaxWithSessionCookieJar({
      cookie: FULL_COOKIE,
      endpoint: MINIMAX_USAGE_ENDPOINT,
      groupId: '12345',
      signal: controller.signal
    })
    expect(sessionFromPartitionMock).toHaveBeenCalledWith('orca-minimax-rate-limit-fetch')
    expect(clearStorageDataMock).toHaveBeenCalledWith({
      origin: 'https://platform.minimax.io',
      storages: ['cookies']
    })
  })

  it('sets every cookie pair onto the session jar with secure + path /', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [] })
    })
    const controller = new AbortController()
    await fetchMiniMaxWithSessionCookieJar({
      cookie: '_token=tok; ak_bmsc=ak; minimax_group_id_v2=42',
      endpoint: MINIMAX_USAGE_ENDPOINT,
      groupId: null,
      signal: controller.signal
    })
    expect(cookiesSetMock).toHaveBeenCalledTimes(3)
    const setDetails = cookiesSetMock.mock.calls.map((call) => {
      const [details] = call as unknown as [
        { name: string; value: string; secure: boolean; path: string }
      ]
      return details
    })
    expect(setDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '_token', value: 'tok', secure: true, path: '/' }),
        expect.objectContaining({ name: 'ak_bmsc', value: 'ak', secure: true, path: '/' }),
        expect.objectContaining({
          name: 'minimax_group_id_v2',
          value: '42',
          secure: true,
          path: '/'
        })
      ])
    )
  })

  it('reports the transport name as session-cookie-jar on success', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [] })
    })
    const controller = new AbortController()
    const result = await fetchMiniMaxWithSessionCookieJar({
      cookie: FULL_COOKIE,
      endpoint: MINIMAX_USAGE_ENDPOINT,
      groupId: '12345',
      signal: controller.signal
    })
    expect(result.transport).toBe('session-cookie-jar')
    expect(result.cookieNames).toEqual([
      '_token',
      '_twpid',
      'minimax_group_id_v2',
      'platform_cookie_consent'
    ])
    expect(result.requestHeaderNames).toContain('X-Group-Id')
  })
})

describe('fetchMiniMaxWithManualCookieHeader', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('attaches the full Cookie header and X-Group-Id via net.fetch', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [] })
    })
    const controller = new AbortController()
    const result = await fetchMiniMaxWithManualCookieHeader({
      cookie: FULL_COOKIE,
      endpoint: MINIMAX_USAGE_ENDPOINT,
      groupId: '12345',
      signal: controller.signal
    })
    expect(result.transport).toBe('manual-cookie-header')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe(MINIMAX_USAGE_ENDPOINT)
    expect(init.method).toBe('GET')
    expect(init.headers.Cookie).toBe(FULL_COOKIE)
    expect(init.headers['X-Group-Id']).toBe('12345')
  })

  it('omits X-Group-Id when groupId is null', async () => {
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [] })
    })
    const controller = new AbortController()
    await fetchMiniMaxWithManualCookieHeader({
      cookie: FULL_COOKIE,
      endpoint: MINIMAX_USAGE_ENDPOINT,
      groupId: null,
      signal: controller.signal
    })
    const [, init] = netFetchMock.mock.calls[0]
    expect(init.headers['X-Group-Id']).toBeUndefined()
  })
})

describe('logMiniMaxFetchFailure', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs structured fields without leaking cookie values', () => {
    logMiniMaxFetchFailure({
      transport: 'session-cookie-jar',
      responseStatus: 200,
      statusCode: 7,
      statusMsg: '_token=eyJhABCDEF ak_bmsc=secretvalue',
      cookieNames: ['_token', 'ak_bmsc'],
      requestHeaderNames: ['Accept', 'X-Group-Id']
    })
    expect(warn).toHaveBeenCalledWith(
      '[minimax] usage fetch failed',
      expect.objectContaining({
        transport: 'session-cookie-jar',
        responseStatus: 200,
        baseRespStatusCode: 7,
        baseRespStatusMsg: expect.not.stringContaining('eyJhABCDEF'),
        cookieNames: ['_token', 'ak_bmsc'],
        requestHeaderNames: ['Accept', 'X-Group-Id']
      })
    )
  })

  it('logs without redacting when statusMsg is not a string', () => {
    logMiniMaxFetchFailure({
      transport: 'manual-cookie-header',
      responseStatus: 401,
      statusCode: undefined,
      statusMsg: undefined,
      cookieNames: ['_token'],
      requestHeaderNames: ['Accept']
    })
    expect(warn).toHaveBeenCalledWith(
      '[minimax] usage fetch failed',
      expect.objectContaining({
        transport: 'manual-cookie-header',
        responseStatus: 401,
        baseRespStatusCode: undefined,
        baseRespStatusMsg: undefined
      })
    )
  })
})
