import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const cookiesSetMock = vi.hoisted(() => vi.fn())
const clearStorageDataMock = vi.hoisted(() => vi.fn())
const resolveProxyMock = vi.hoisted(() => vi.fn())
const setProxyMock = vi.hoisted(() => vi.fn())
const fromPartitionMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  session: { fromPartition: fromPartitionMock }
}))

import { fetchOpenCodeGoRateLimits, normalizeCookieInput } from './opencode-go-usage-fetcher'

const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status'
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status'
const LEGACY_WORKSPACE_GO_URL = /https:\/\/opencode\.ai\/workspace\/[^/]+\/go/

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  } as Response
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return makeResponse(JSON.stringify(body), status)
}

const STATUS_WITH_MONTHLY = {
  access: {
    meters: {
      fiveHour: {
        resetsAt: '2026-04-24T14:00:00.000Z',
        limitMicroCents: '1000',
        usedMicroCents: '300'
      },
      week: {
        resetsAt: '2026-05-01T12:00:00.000Z',
        limitMicroCents: '1000',
        usedMicroCents: '510'
      },
      month: {
        resetsAt: '2026-05-24T12:00:00.000Z',
        limitMicroCents: '1000',
        usedMicroCents: '890'
      }
    }
  }
}

const STATUS_NO_MONTHLY = {
  access: {
    meters: {
      fiveHour: {
        resetsAt: '2026-04-24T13:00:00.000Z',
        limitMicroCents: '100',
        usedMicroCents: '10'
      },
      week: {
        resetsAt: '2026-04-25T12:00:00.000Z',
        limitMicroCents: '100',
        usedMicroCents: '20'
      }
    }
  }
}

const LEGACY_USAGE_PAGE = `
<html><body><script>
$R[20]={rollingUsage:$R[21]={status:"ok",resetInSec:7200,usagePercent:30},weeklyUsage:$R[22]={status:"ok",resetInSec:259200,usagePercent:51},monthlyUsage:$R[23]={status:"ok",resetInSec:1296000,usagePercent:89}};
</script></body></html>
`

const WORKSPACES_RESPONSE = 'id: "wrk_TESTWORKSPACEID123"'

function requestedUrls(): string[] {
  return netFetchMock.mock.calls.map(([url]) => String(url))
}

describe('fetchOpenCodeGoRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    netFetchMock.mockReset()
    cookiesSetMock.mockReset().mockResolvedValue(undefined)
    clearStorageDataMock.mockReset().mockResolvedValue(undefined)
    resolveProxyMock.mockReset().mockResolvedValue('PROXY system.example:8080')
    setProxyMock.mockReset().mockResolvedValue(undefined)
    fromPartitionMock.mockReset().mockReturnValue({
      fetch: netFetchMock,
      cookies: { set: cookiesSetMock },
      clearStorageData: clearStorageDataMock,
      resolveProxy: resolveProxyMock,
      setProxy: setProxyMock,
      closeAllConnections: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('returns unavailable when cookie is empty', async () => {
    const result = await fetchOpenCodeGoRateLimits('')

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('opencode-go')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toBeNull()
    expect(result.error).toBe('Session cookie not configured')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when cookie is only whitespace', async () => {
    const result = await fetchOpenCodeGoRateLimits('   ')

    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns error when cookie has no known auth name', async () => {
    const result = await fetchOpenCodeGoRateLimits('session=abc123; other=xyz')

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/No auth cookie found/)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  describe('normalizeCookieInput', () => {
    it('returns empty string unchanged', () => {
      expect(normalizeCookieInput('')).toBe('')
      expect(normalizeCookieInput('   ')).toBe('')
    })

    it('wraps a bare token as auth=<token>', () => {
      expect(normalizeCookieInput('Fe26.2**abc123')).toBe('auth=Fe26.2**abc123')
    })

    it('leaves auth=... unchanged', () => {
      expect(normalizeCookieInput('auth=Fe26.2**abc123')).toBe('auth=Fe26.2**abc123')
    })

    it('leaves __Host-auth=... unchanged', () => {
      expect(normalizeCookieInput('__Host-auth=token')).toBe('__Host-auth=token')
    })

    it('leaves __Host-console_session=... unchanged', () => {
      expect(normalizeCookieInput('__Host-console_session=consoleTok')).toBe(
        '__Host-console_session=consoleTok'
      )
    })

    it('leaves multi-pair cookie headers unchanged', () => {
      expect(normalizeCookieInput('auth=tok; other=val')).toBe('auth=tok; other=val')
      expect(normalizeCookieInput('auth=tok; __Host-console_session=consoleTok')).toBe(
        'auth=tok; __Host-console_session=consoleTok'
      )
    })

    it('trims surrounding whitespace before wrapping', () => {
      expect(normalizeCookieInput('  Fe26.2**abc  ')).toBe('auth=Fe26.2**abc')
    })

    it('does not wrap unknown or malformed tokens', () => {
      expect(normalizeCookieInput('invalid token format')).toBe('invalid token format')
      expect(normalizeCookieInput('{}')).toBe('{}')
      expect(normalizeCookieInput('{"token":"abc"}')).toBe('{"token":"abc"}')
    })
  })

  it('accepts a bare token (auto-wraps to auth=<token>)', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('Fe26.2**baretoken')

    expect(result.status).toBe('ok')
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth', value: 'Fe26.2**baretoken' })
    )
  })

  it('uses GET /_server?id=<hash> with correct headers for workspaces', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      `https://opencode.ai/_server?id=${WORKSPACES_SERVER_ID}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Server-Id': WORKSPACES_SERVER_ID
        })
      })
    )
    expect(netFetchMock.mock.calls[0][1].headers).not.toHaveProperty('Cookie')
  })

  it('uses an isolated session cookie jar and clears it after fetching', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(fromPartitionMock).toHaveBeenCalledWith('orca-opencode-go-rate-limit-fetch')
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
    expect(clearStorageDataMock).toHaveBeenLastCalledWith({
      origin: 'https://opencode.ai',
      storages: ['cookies']
    })
  })

  it('clears partially installed cookies when cookie setup fails', async () => {
    cookiesSetMock.mockRejectedValueOnce(new Error('cookie rejected'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('cookie rejected')
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('finishes each cookie write before starting the next one', async () => {
    let resolveFirstCookie!: () => void
    let markFirstCookieStarted!: () => void
    const firstCookiePending = new Promise<void>((resolve) => {
      resolveFirstCookie = resolve
    })
    const firstCookieStarted = new Promise<void>((resolve) => {
      markFirstCookieStarted = resolve
    })
    cookiesSetMock
      .mockImplementationOnce(() => {
        markFirstCookieStarted()
        return firstCookiePending
      })
      .mockRejectedValueOnce(new Error('second cookie rejected'))

    const resultPending = fetchOpenCodeGoRateLimits('auth=first; __Host-auth=second')
    await firstCookieStarted

    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    resolveFirstCookie()
    const result = await resultPending

    expect(result.error).toBe('second cookie rejected')
    expect(cookiesSetMock).toHaveBeenCalledTimes(2)
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
  })

  it('applies configured proxy settings once to the isolated session', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))
      .mockResolvedValueOnce(makeResponse('unavailable', 503))
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))
      .mockResolvedValueOnce(makeResponse('unavailable', 503))

    const proxySettings = {
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost, *.internal'
    }
    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', undefined, proxySettings)
    const repeatedResult = await fetchOpenCodeGoRateLimits('auth=mytoken', undefined, proxySettings)

    expect(result.status).toBe('ok')
    expect(repeatedResult.status).toBe('ok')
    expect(setProxyMock).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080',
      proxyBypassRules: 'localhost;*.internal'
    })
    expect(setProxyMock).toHaveBeenCalledTimes(1)
    expect(resolveProxyMock).not.toHaveBeenCalled()
  })

  it('does not bypass an explicitly configured proxy when setup fails', async () => {
    setProxyMock.mockRejectedValueOnce(new Error('proxy setup failed'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', undefined, {
      httpProxyUrl: 'http://proxy.example:8080'
    })

    expect(result.error).toBe('proxy setup failed')
    expect(cookiesSetMock).not.toHaveBeenCalled()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('fetches usage from /console/api/go/status with x-org-id and never scrapes /workspace/<id>/go', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(requestedUrls().some((url) => LEGACY_WORKSPACE_GO_URL.test(url))).toBe(false)
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      CONSOLE_STATUS_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-org-id': 'wrk_TESTWORKSPACEID123',
          Accept: 'application/json'
        })
      })
    )
    expect(netFetchMock.mock.calls[1][1].headers).not.toHaveProperty('Cookie')
  })

  it('returns ok with session, weekly, and monthly windows from JSON meters', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session).toEqual({
      usedPercent: 30,
      windowMinutes: 300,
      resetsAt: Date.parse('2026-04-24T14:00:00.000Z'),
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 51,
      windowMinutes: 10_080,
      resetsAt: Date.parse('2026-05-01T12:00:00.000Z'),
      resetDescription: null
    })
    expect(result.monthly).toEqual({
      usedPercent: 89,
      windowMinutes: 43_200,
      resetsAt: Date.parse('2026-05-24T12:00:00.000Z'),
      resetDescription: null
    })
  })

  it.each(['discovery', 'override'])('accepts an org_ workspace from %s', async (source) => {
    netFetchMock.mockImplementation(async (url) => {
      if (String(url).startsWith('https://opencode.ai/_server')) {
        return makeResponse('id: "org_CONSOLE123"')
      }
      return url === CONSOLE_STATUS_URL
        ? makeJsonResponse(STATUS_WITH_MONTHLY)
        : makeJsonResponse({
            billingMode: 'prepaid',
            mode: 'pay-as-you-go',
            balanceMicroCents: '2786781005'
          })
    })

    const result = await fetchOpenCodeGoRateLimits(
      '__Host-console_session=placeholder',
      source === 'override' ? 'org_CONSOLE123' : undefined
    )

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(30)
    expect(result.extraUsage?.balance).toBe(27.86781005)
    expect(netFetchMock).toHaveBeenCalledWith(
      CONSOLE_BILLING_STATUS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-org-id': 'org_CONSOLE123' })
      })
    )
  })

  it('enriches the selected cookie workspace with its verified PAYG Zen balance', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY)).mockResolvedValueOnce(
      makeJsonResponse({
        billingMode: 'prepaid',
        mode: 'pay-as-you-go',
        balanceMicroCents: '2786781005'
      })
    )

    const result = await fetchOpenCodeGoRateLimits(
      '__Host-console_session=consoleTok',
      'wrk_OVERRIDE123'
    )

    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      CONSOLE_BILLING_STATUS_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-org-id': 'wrk_OVERRIDE123',
          Accept: 'application/json'
        })
      })
    )
    expect(netFetchMock.mock.calls[1][1].headers).not.toHaveProperty('Cookie')
    expect(result.extraUsage).toEqual({
      balance: 27.86781005,
      unit: 'currency',
      currencyCode: 'USD',
      enabled: true,
      disabledReason: null,
      spent: null,
      spendLimit: null,
      spentPercent: null,
      resetsAt: null
    })
  })

  it.each([
    [
      'unsupported mode',
      makeJsonResponse({ billingMode: 'seat', mode: 'pay-as-you-go' }),
      'billing-unavailable'
    ],
    ['billing failure', makeResponse('unavailable', 503), 'refresh-failed']
  ])(
    'keeps valid quota when optional billing has an %s',
    async (_label, billingResponse, disabledReason) => {
      netFetchMock
        .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))
        .mockResolvedValueOnce(billingResponse)

      const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

      expect(result.status).toBe('ok')
      expect(result.session?.usedPercent).toBe(30)
      expect(result.extraUsage).toEqual(
        expect.objectContaining({ balance: null, enabled: false, disabledReason })
      )
    }
  )

  it('returns a verified balance-only snapshot for explicit access:null', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse({ access: null })).mockResolvedValueOnce(
      makeJsonResponse({
        billingMode: 'prepaid',
        mode: 'pay-as-you-go',
        balanceMicroCents: '0'
      })
    )

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

    expect(result).toEqual(
      expect.objectContaining({
        provider: 'opencode-go',
        session: null,
        weekly: null,
        monthly: null,
        error: null,
        status: 'ok',
        extraUsage: expect.objectContaining({ balance: 0, currencyCode: 'USD' })
      })
    )
  })

  it('returns a verified balance-only snapshot for an explicit JSON null status', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse(null)).mockResolvedValueOnce(
      makeJsonResponse({
        billingMode: 'prepaid',
        mode: 'pay-as-you-go',
        balanceMicroCents: '-125000000'
      })
    )

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

    expect(result.status).toBe('ok')
    expect(result.session).toBeNull()
    expect(result.extraUsage).toEqual(expect.objectContaining({ balance: -1.25 }))
  })

  it('aborts billing before returning a generic malformed-usage error', async () => {
    let billingSignal: AbortSignal | undefined
    netFetchMock
      .mockResolvedValueOnce(makeJsonResponse({ access: {} }))
      .mockImplementationOnce((_url, init: RequestInit) => {
        billingSignal = init.signal ?? undefined
        return new Promise<Response>((resolve, reject) => {
          billingSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
          setTimeout(
            () =>
              resolve(
                makeJsonResponse({
                  billingMode: 'prepaid',
                  mode: 'pay-as-you-go',
                  balanceMicroCents: '100000000'
                })
              ),
            100
          )
        })
      })

    const resultPromise = fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')
    await vi.advanceTimersByTimeAsync(0)
    const abortedBeforeBillingResponse = billingSignal?.aborted
    await vi.advanceTimersByTimeAsync(100)
    const result = await resultPromise

    expect(abortedBeforeBillingResponse).toBe(true)
    expect(result.status).toBe('error')
    expect(result.error).toBe('Could not parse usage data')
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
  })

  it('prefers a later valid Go workspace over an earlier balance-only candidate', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('id: "wrk_FIRST" id: "wrk_SECOND"'))
      .mockResolvedValueOnce(makeJsonResponse({ access: null }))
      .mockResolvedValueOnce(
        makeJsonResponse({
          billingMode: 'prepaid',
          mode: 'pay-as-you-go',
          balanceMicroCents: '900000000'
        })
      )
      .mockResolvedValueOnce(makeJsonResponse(STATUS_NO_MONTHLY))
      .mockResolvedValueOnce(makeResponse('unavailable', 503))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.extraUsage).toEqual(
      expect.objectContaining({ balance: null, enabled: false, disabledReason: 'refresh-failed' })
    )
    expect(netFetchMock).toHaveBeenNthCalledWith(
      4,
      CONSOLE_STATUS_URL,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-org-id': 'wrk_SECOND' }) })
    )
  })

  it('aborts and settles an optional billing timeout before clearing the cookie jar', async () => {
    let billingSignal: AbortSignal | undefined
    netFetchMock
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))
      .mockImplementationOnce((_url, init: RequestInit) => {
        billingSignal = init.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          billingSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
      })

    const resultPromise = fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await resultPromise

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(30)
    expect(billingSignal?.aborted).toBe(true)
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
  })

  it('aborts and settles billing before continuing after a non-ok usage response', async () => {
    let billingSignal: AbortSignal | undefined
    let billingSettled = false
    netFetchMock
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))
      .mockImplementationOnce((_url, init: RequestInit) => {
        billingSignal = init.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          billingSignal?.addEventListener(
            'abort',
            () => {
              billingSettled = true
              reject(new Error('aborted'))
            },
            { once: true }
          )
        })
      })

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

    expect(result.status).toBe('error')
    expect(result.error).toContain('Usage fetch failed (401)')
    expect(billingSignal?.aborted).toBe(true)
    expect(billingSettled).toBe(true)
    expect(clearStorageDataMock).toHaveBeenCalledTimes(2)
  })

  it('returns ok with null monthly when the month meter is absent', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_NO_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.weekly?.usedPercent).toBe(20)
    expect(result.monthly).toBeNull()
  })

  it('caps usedPercent at 100 and floors at 0', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE)).mockResolvedValueOnce(
      makeJsonResponse({
        access: {
          meters: {
            fiveHour: {
              resetsAt: '2026-04-24T13:00:00.000Z',
              limitMicroCents: '100',
              usedMicroCents: '150'
            },
            week: {
              resetsAt: '2026-04-25T12:00:00.000Z',
              limitMicroCents: '100',
              usedMicroCents: '-5'
            }
          }
        }
      })
    )

    const result = await fetchOpenCodeGoRateLimits('auth=token')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(100)
    expect(result.weekly?.usedPercent).toBe(0)
  })

  it('does not treat the old HTML usage page as success', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(LEGACY_USAGE_PAGE))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Could not parse usage data')
    expect(result.session).toBeNull()
  })

  it('skips workspace lookup when workspaceIdOverride is provided', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(requestedUrls().some((url) => LEGACY_WORKSPACE_GO_URL.test(url))).toBe(false)
    expect(netFetchMock).toHaveBeenCalledWith(
      CONSOLE_STATUS_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-org-id': 'wrk_OVERRIDE123' })
      })
    )
    expect(result.status).toBe('ok')
  })

  it('keeps __Host-console_session and drops unrelated cookie names', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits(
      'session=secret; __Host-console_session=consoleTok; tracking=xyz; auth=realtoken',
      'wrk_OVERRIDE123'
    )

    expect(cookiesSetMock).toHaveBeenCalledTimes(2)
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '__Host-console_session', value: 'consoleTok' })
    )
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth', value: 'realtoken' })
    )
    expect(cookiesSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'session' }))
    expect(cookiesSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'tracking' }))
  })

  it('accepts a console session cookie without wrapping it as auth=', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits(
      '__Host-console_session=consoleTok',
      'wrk_OVERRIDE123'
    )

    expect(result.status).toBe('ok')
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '__Host-console_session', value: 'consoleTok' })
    )
  })

  it('filters cookie to auth name only', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeJsonResponse(STATUS_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('session=secret; auth=realtoken; tracking=xyz')

    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth', value: 'realtoken' })
    )
  })

  it('returns error on 404 from workspaces fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Not Found', 404))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspaces fetch failed (404)')
    expect(result.session).toBeNull()
  })

  it('returns error on 401 from workspaces fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspaces fetch failed (401)')
  })

  it('returns error when no workspace ID found in response', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('no workspace id here'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/No workspace found.*OpenCode Go API key/)
  })

  it('returns error on non-ok usage response', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse('Not Found', 404))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Usage fetch failed (404)')
  })

  it('tells the user to include __Host-console_session when usage fetch returns 401', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe(
      'Usage fetch failed (401) — paste the full Cookie header including __Host-console_session (auth alone is not enough)'
    )
  })

  it('returns error when usage data cannot be parsed', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse('{"access":{}}'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Could not parse usage data')
  })

  it('never logs the cookie in error messages', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    const result = await fetchOpenCodeGoRateLimits('auth=secret123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('network timeout')
    expect(result.error).not.toContain('secret123')
  })
})
