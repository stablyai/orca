import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted<{
  credentials: string | null
  readError: Error | null
  writes: Map<string, string>
  writeOptions: Map<string, unknown>
  renames: { from: string; to: string }[]
  readPaths: string[]
}>(() => ({
  credentials: null,
  readError: null,
  writes: new Map(),
  writeOptions: new Map(),
  renames: [],
  readPaths: []
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: () => fsState.credentials !== null,
  readFileSync: (path: string) => {
    fsState.readPaths.push(path)
    if (fsState.readError) {
      throw fsState.readError
    }
    if (fsState.credentials === null) {
      throw new Error('ENOENT')
    }
    return fsState.credentials
  },
  writeFileSync: (path: string, value: string, options?: unknown) => {
    fsState.writes.set(path, value)
    fsState.writeOptions.set(path, options)
  },
  renameSync: (from: string, to: string) => {
    fsState.renames.push({ from, to })
    const value = fsState.writes.get(from)
    if (value !== undefined) {
      fsState.credentials = value
      fsState.writes.delete(from)
    }
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

vi.mock('../../shared/secure-file', () => ({
  writeSecureJsonFile: (path: string, value: unknown) => {
    const tmpPath = `${path}.test.tmp`
    fsState.writes.set(tmpPath, `${JSON.stringify(value, null, 2)}\n`)
    fsState.writeOptions.set(tmpPath, { encoding: 'utf-8', mode: 0o600 })
    fsState.renames.push({ from: tmpPath, to: path })
    fsState.credentials = fsState.writes.get(tmpPath) ?? null
    fsState.writes.delete(tmpPath)
  }
}))

import { fetchKimiRateLimits } from './kimi-fetcher'
import { resolveKimiCredentialLocation } from './kimi-credential-location'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

// Real shape captured from GET https://api.kimi.com/coding/v1/usages.
const USAGE_RESPONSE = {
  user: { userId: 'u1', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '1000', remaining: '1000', resetTime: '2026-06-09T07:52:41.230862Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '40', resetTime: '2026-06-04T08:52:41.230862Z' }
    }
  ],
  subType: 'TYPE_PURCHASE'
}

function freshCredentials(): string {
  // expires_at far in the future (seconds).
  return JSON.stringify({ access_token: 'tok-abc', expires_at: 99_999_999_999 })
}

describe('fetchKimiRateLimits', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_DISABLE_OAUTH_LOCK', '1')
    netFetchMock.mockReset()
    fsState.credentials = null
    fsState.readError = null
    fsState.writes.clear()
    fsState.writeOptions.clear()
    fsState.renames = []
    fsState.readPaths = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchKimiRateLimits()
    expect(result.provider).toBe('kimi')
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps the usages payload to session (5h) and weekly windows', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('kimi')
    // 5h window from limits[]: 40/100 remaining → 60% used.
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBeCloseTo(60)
    // Weekly from top-level usage: 1000/1000 remaining → 0% used.
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.weekly?.usedPercent).toBeCloseTo(0)
    // Bearer token from the credentials file is sent.
    const [, init] = netFetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')
  })

  it('surfaces an error when the usage request fails', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('surfaces an error when the credentials file cannot be parsed', async () => {
    fsState.credentials = '{'

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/json/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error when the credentials file cannot be read', async () => {
    fsState.credentials = freshCredentials()
    fsState.readError = new Error('EACCES')

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty usage payload as an error', async () => {
    fsState.credentials = freshCredentials()
    netFetchMock.mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/quota windows/)
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('refreshes an expired access token before fetching usage', async () => {
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      refresh_token: 'refresh-old',
      expires_at: 1,
      token_type: 'Bearer',
      scope: 'kimi-code'
    })
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'tok-new',
          refresh_token: 'refresh-new',
          expires_in: 900,
          token_type: 'Bearer',
          scope: 'kimi-code'
        })
      )
      .mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    const [refreshUrl, refreshInit] = netFetchMock.mock.calls[0]
    expect(refreshUrl).toBe('https://auth.kimi.com/api/oauth/token')
    const refreshBody = new URLSearchParams(refreshInit.body as string)
    expect(refreshBody.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098')
    expect(refreshBody.get('grant_type')).toBe('refresh_token')
    expect(refreshBody.get('refresh_token')).toBe('refresh-old')
    const [, usageInit] = netFetchMock.mock.calls[1]
    expect((usageInit.headers as Record<string, string>).Authorization).toBe('Bearer tok-new')
    expect(fsState.renames).toHaveLength(1)
    const [{ from: tmpPath }] = fsState.renames
    expect(fsState.writeOptions.get(tmpPath)).toEqual({ encoding: 'utf-8', mode: 0o600 })
    expect(JSON.parse(fsState.credentials ?? '{}')).toMatchObject({
      access_token: 'tok-new',
      refresh_token: 'refresh-new',
      expires_in: 900,
      token_type: 'Bearer',
      scope: 'kimi-code'
    })
    expect(JSON.parse(fsState.credentials ?? '{}').expires_at).toBeGreaterThan(1)
  })

  it('uses credentials refreshed by the Kimi CLI when its refresh wins the race', async () => {
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      refresh_token: 'refresh-old',
      expires_at: 1
    })
    netFetchMock
      .mockImplementationOnce(async () => {
        fsState.credentials = JSON.stringify({
          access_token: 'tok-cli',
          refresh_token: 'refresh-cli',
          expires_at: 99_999_999_999
        })
        return jsonResponse({ error: 'invalid_grant' }, 400)
      })
      .mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
    const [, usageInit] = netFetchMock.mock.calls[1]
    expect((usageInit.headers as Record<string, string>).Authorization).toBe('Bearer tok-cli')
    expect(fsState.renames).toHaveLength(0)
  })

  it('returns user-safe unauthorized refresh copy after persisting revocation', async () => {
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      refresh_token: 'refresh-old',
      expires_at: 1
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 401))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toBe('Kimi token refresh unauthorized - run kimi login')
    expect(JSON.parse(fsState.credentials ?? '{}')).toMatchObject({
      access_token: '',
      refresh_token: ''
    })
  })

  it('does NOT refresh or call the API when the expired token has no refresh token', async () => {
    fsState.credentials = JSON.stringify({ access_token: 'tok-old', expires_at: 1 })

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('uses only the endpoint-scoped credential for refresh and usage', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '/kimi-home')
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.example.com')
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.example.com/coding/v1')
    fsState.credentials = JSON.stringify({
      access_token: 'scoped-old',
      refresh_token: 'scoped-refresh',
      expires_at: 1
    })
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'scoped-new',
          refresh_token: 'scoped-rotated',
          expires_in: 900
        })
      )
      .mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    const scopedPath = '/kimi-home/credentials/kimi-code-env-3e58296a497444bf.json'
    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([scopedPath, scopedPath])
    expect(fsState.readPaths).not.toContain('/kimi-home/credentials/kimi-code.json')
    expect(netFetchMock.mock.calls[0][0]).toBe('https://auth.example.com/api/oauth/token')
    expect(netFetchMock.mock.calls[1][0]).toBe('https://api.example.com/coding/v1/usages')
    expect(fsState.renames[0].to).toBe(scopedPath)
  })
})

describe('resolveKimiCredentialLocation', () => {
  it.each([
    ['https://auth.kimi.com', 'https://api.kimi.com/coding/v1', 'kimi-code.json'],
    [
      'https://auth.example.com',
      'https://api.kimi.com/coding/v1',
      'kimi-code-env-d5c8af65e27873b9.json'
    ],
    [
      'https://auth.kimi.com',
      'https://api.example.com/coding/v1',
      'kimi-code-env-bf2242cfc5d51611.json'
    ],
    [
      'https://auth.example.com',
      'https://api.example.com/coding/v1',
      'kimi-code-env-3e58296a497444bf.json'
    ]
  ])('matches the Kimi credential vector for %s and %s', (oauthHost, baseUrl, filename) => {
    const location = resolveKimiCredentialLocation(
      {
        KIMI_CODE_HOME: '/kimi-home',
        KIMI_CODE_OAUTH_HOST: oauthHost,
        KIMI_CODE_BASE_URL: baseUrl
      },
      '/fallback-home'
    )

    expect(location.credentialsPath).toBe(`/kimi-home/credentials/${filename}`)
  })

  it('scopes credentials, lock, and request URLs to the normalized endpoint pair', () => {
    const location = resolveKimiCredentialLocation(
      {
        KIMI_CODE_HOME: '/kimi-home',
        KIMI_CODE_OAUTH_HOST: '  https://auth.example.com///  ',
        KIMI_CODE_BASE_URL: 'https://api.example.com/coding/v1///'
      },
      '/fallback-home'
    )

    expect(location).toEqual({
      home: '/kimi-home',
      oauthHost: 'https://auth.example.com',
      baseUrl: 'https://api.example.com/coding/v1',
      storageName: 'kimi-code-env-3e58296a497444bf',
      credentialsPath: '/kimi-home/credentials/kimi-code-env-3e58296a497444bf.json',
      lockTarget: '/kimi-home/oauth/kimi-code-env-3e58296a497444bf',
      tokenUrl: 'https://auth.example.com/api/oauth/token',
      usageUrl: 'https://api.example.com/coding/v1/usages'
    })
  })
})
