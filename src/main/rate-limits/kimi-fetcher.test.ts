import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

const fetchMock = vi.fn()
const fsState = vi.hoisted<{
  config: string | null
  credentials: string | null
  credentialsByPath: Record<string, string>
  missingPaths: string[]
  readError: Error | null
  readPaths: string[]
}>(() => ({
  config: null,
  credentials: null,
  credentialsByPath: {},
  missingPaths: [],
  readError: null,
  readPaths: []
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const p = String(path)
    fsState.readPaths.push(p)
    if (fsState.readError) {
      throw fsState.readError
    }
    const missing = (): Error => {
      const error = new Error('ENOENT: no such file or directory')
      Object.assign(error, { code: 'ENOENT' })
      return error
    }
    if (p.endsWith('config.toml')) {
      if (fsState.config === null) {
        throw missing()
      }
      return fsState.config
    }
    if (fsState.missingPaths.includes(p)) {
      throw missing()
    }
    if (p in fsState.credentialsByPath) {
      return fsState.credentialsByPath[p]
    }
    if (fsState.credentials === null) {
      throw missing()
    }
    return fsState.credentials
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchKimiRateLimits } from './kimi-fetcher'
import { clearCachedKimiSlot } from './kimi-config-slot'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

// Real shape captured from GET https://api.kimi.com/coding/v1/usages.
const USAGE_RESPONSE = {
  user: { userId: 'u1', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: {
    limit: '1000',
    remaining: '1000',
    resetTime: '2026-06-09T07:52:41.230862Z'
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '100',
        remaining: '40',
        resetTime: '2026-06-04T08:52:41.230862Z'
      }
    }
  ],
  subType: 'TYPE_PURCHASE'
}

// Built with `join` so the expectation matches the separator the fetcher emits on this platform.
function hostConfigPath(kimiHome: string): string {
  return join(kimiHome, 'config.toml')
}

function hostCredentialsPath(kimiHome: string, slot = 'kimi-code'): string {
  return join(kimiHome, 'credentials', `${slot}.json`)
}

function scopedSlotConfig(key: string): string {
  return `[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "${key}"\noauth_host = "https://auth.kimi.ai"\n`
}

function freshCredentials(): string {
  // expires_at far in the future (seconds).
  return JSON.stringify({
    access_token: 'tok-abc',
    expires_at: 99_999_999_999
  })
}

describe('fetchKimiRateLimits', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fsState.config = null
    fsState.credentials = null
    fsState.credentialsByPath = {}
    fsState.missingPaths = []
    fsState.readError = null
    fsState.readPaths = []
    // Why: the scoped-slot cache lives in the kimi-config-slot module and
    // survives between polls; tests must not leak discoveries into each other.
    clearCachedKimiSlot('/home/test/.kimi-code')
    clearCachedKimiSlot('/custom/kimi-home')
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
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps the usages payload to session (5h) and weekly windows', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

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
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-abc')
  })

  it('surfaces an error when the usage request fails', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('tags a request that throws before a response as a network failure', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))

    const result = await fetchKimiRateLimits()
    expect(result.error).toBe('net::ERR_PROXY_CONNECTION_FAILED')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('tags a malformed usage body as a parse failure, not a network one', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    const result = await fetchKimiRateLimits()
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('surfaces an error when the credentials file cannot be parsed', async () => {
    fsState.credentials = '{'

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/json/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error when the credentials file cannot be read', async () => {
    fsState.credentials = freshCredentials()
    fsState.readError = new Error('EACCES')

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty usage payload as an error', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/quota windows/)
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('does NOT refresh or call the API when the token is expired (read-only)', async () => {
    // expires_at in the past → token stale; fetcher must not hit the network.
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(result.error).toMatch(/run kimi on the computer running Orca/i)
    expect(result.usageMetadata).toEqual({
      failureKind: 'delegated-refresh-required',
      source: 'oauth'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the host ~/.kimi-code credentials by default', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    // A healthy default slot never triggers the config probe.
    expect(fsState.readPaths).toEqual([hostCredentialsPath('/home/test/.kimi-code')])
  })

  it('honors KIMI_CODE_HOME for the host home', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '/custom/kimi-home')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([hostCredentialsPath('/custom/kimi-home')])
  })

  it('ignores a blank KIMI_CODE_HOME instead of reading from the process cwd', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '   ')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths).toEqual([hostCredentialsPath('/home/test/.kimi-code')])
  })

  it('reads the scoped OAuth slot named by config.toml when the default slot is stale (#24176)', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostCredentialsPath('/home/test/.kimi-code'),
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code', slot)
    ])
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-scoped')
  })

  it('caches the scoped slot so later polls skip the probe and the default read', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const first = await fetchKimiRateLimits()
    expect(first.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fsState.readPaths = []
    const second = await fetchKimiRateLimits()
    expect(second.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Steady state for a scoped user: exactly one read, and it is the slot file.
    expect(fsState.readPaths).toEqual([hostCredentialsPath('/home/test/.kimi-code', slot)])
  })

  it('keeps reading the default slot when config.toml names the shared default key', async () => {
    // auth.kimi.com users have an explicit `oauth/kimi-code` key. Their default
    // token is healthy, so the probe never runs and nothing redirects them.
    fsState.config = scopedSlotConfig('oauth/kimi-code')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([hostCredentialsPath('/home/test/.kimi-code')])
  })

  it('reports not signed in when the default slot is absent and config names it anyway', async () => {
    fsState.config = scopedSlotConfig('oauth/kimi-code')

    const result = await fetchKimiRateLimits()

    // The probe resolves to the default slot, so the outcome matches a plain
    // missing credentials file — no redirect, no new error mode.
    expect(result.status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops the cached slot when the file disappears and recovers when it returns', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    const scopedPath = hostCredentialsPath('/home/test/.kimi-code', slot)
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const first = await fetchKimiRateLimits()
    expect(first.status).toBe('ok')

    // The CLI removes the environment: cached read goes missing, cache drops,
    // and the user falls back to the default slot's expired error.
    delete fsState.credentialsByPath[scopedPath]
    fsState.missingPaths = [scopedPath]
    const second = await fetchKimiRateLimits()
    expect(second.status).toBe('error')
    expect(second.error).toMatch(/expired/i)

    // Self-heals without a restart once the file is back.
    fsState.missingPaths = []
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    const third = await fetchKimiRateLimits()
    expect(third.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps serving the cached scoped slot when its token goes stale', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    const scopedPath = hostCredentialsPath('/home/test/.kimi-code', slot)
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const first = await fetchKimiRateLimits()
    expect(first.status).toBe('ok')

    // Token expires between polls while the file stays put: the scoped slot
    // keeps precedence and surfaces its own delegated-refresh error instead of
    // redirecting to a default token that may belong to another account.
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 1
    })
    fsState.readPaths = []
    const second = await fetchKimiRateLimits()
    expect(second.status).toBe('error')
    expect(second.error).toMatch(/expired/i)
    expect(second.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    // One read per poll, still only the slot file.
    expect(fsState.readPaths).toEqual([scopedPath])

    // And it recovers once the CLI refreshes the file.
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped-2',
      expires_at: 99_999_999_999
    })
    const third = await fetchKimiRateLimits()
    expect(third.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the default result when the scoped file is corrupt', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = 'not json'

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(fetchMock).not.toHaveBeenCalled()
    // A corrupt scoped file must not be cached: the next poll re-derives.
    fsState.readPaths = []
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))
    const recovered = await fetchKimiRateLimits()
    expect(recovered.status).toBe('ok')
  })

  it('scopes the slot cache per home', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const scopedResult = await fetchKimiRateLimits()
    expect(scopedResult.status).toBe('ok')

    // A different home must not inherit the first home's cached slot.
    vi.stubEnv('KIMI_CODE_HOME', '/custom/kimi-home')
    fsState.credentials = freshCredentials()
    fsState.readPaths = []
    const defaultResult = await fetchKimiRateLimits()
    expect(defaultResult.status).toBe('ok')
    expect(fsState.readPaths).toEqual([hostCredentialsPath('/custom/kimi-home')])
  })

  it('shares one config read between concurrent discovery polls', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const [first, second] = await Promise.all([fetchKimiRateLimits(), fetchKimiRateLimits()])

    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    const configReads = fsState.readPaths.filter(
      (path) => path === hostConfigPath('/home/test/.kimi-code')
    )
    expect(configReads).toHaveLength(1)
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1].headers).get('Authorization')).toBe('Bearer tok-scoped')
    }
  })

  it('does NOT fall back to a fresh default token when the cached scoped token is stale', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    const scopedPath = hostCredentialsPath('/home/test/.kimi-code', slot)
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old-default',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(USAGE_RESPONSE)))

    const first = await fetchKimiRateLimits()
    expect(first.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The default file rotates again with a fresh token — possibly another
    // account — while the scoped token expires: the cached scoped slot keeps
    // precedence, surfacing its delegated-refresh error instead of silently
    // querying usage with the wrong account's token.
    fsState.credentials = JSON.stringify({
      access_token: 'tok-default-fresh',
      expires_at: 99_999_999_999
    })
    fsState.credentialsByPath[scopedPath] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 1
    })
    fsState.readPaths = []
    const second = await fetchKimiRateLimits()
    expect(second.status).toBe('error')
    expect(second.error).toMatch(/expired/i)
    expect(second.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Steady state holds: one read, and it is the cached slot file.
    expect(fsState.readPaths).toEqual([scopedPath])

    // The default file disappearing changes nothing: the scoped slot stands.
    fsState.missingPaths = [hostCredentialsPath('/home/test/.kimi-code')]
    const third = await fetchKimiRateLimits()
    expect(third.status).toBe('error')
    expect(third.usageMetadata?.failureKind).toBe('delegated-refresh-required')
  })

  it('falls back to the default result when the scoped slot was never written', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.missingPaths = [hostCredentialsPath('/home/test/.kimi-code', slot)]

    const result = await fetchKimiRateLimits()

    // The default slot's expired error stays actionable; nothing was cached.
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    fsState.readPaths = []
    fsState.missingPaths = []
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))
    const recovered = await fetchKimiRateLimits()
    expect(recovered.status).toBe('ok')
  })

  it('does NOT fall back to the default slot when the scoped token is expired', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old-default',
      expires_at: 1
    })
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing providers section', '[oauth]\nkey = "oauth/kimi-code-env-abc"\n'],
    ['malformed toml', 'this is [not toml'],
    ['key is not a string', '[providers."managed:kimi-code".oauth]\nkey = 42\n'],
    ['key has no oauth prefix', '[providers."managed:kimi-code".oauth]\nkey = "custom-slot"\n'],
    [
      'key tries to escape the credentials dir',
      '[providers."managed:kimi-code".oauth]\nkey = "oauth/../../other"\n'
    ]
  ])('keeps the default slot when config.toml has %s', async (_label: string, config: string) => {
    fsState.credentials = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })
    fsState.config = config

    const result = await fetchKimiRateLimits()

    // Probe resolves to the default slot on any parse/validation failure, so
    // the user keeps the actionable expired-token error instead of a redirect.
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
