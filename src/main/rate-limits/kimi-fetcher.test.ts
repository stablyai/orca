import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

const fetchMock = vi.fn()
const fsState = vi.hoisted<{
  config: string | null
  credentials: string | null
  readError: Error | null
  readPaths: string[]
}>(() => ({
  config: null,
  credentials: null,
  readError: null,
  readPaths: []
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    fsState.readPaths.push(String(path))
    if (fsState.readError) {
      throw fsState.readError
    }
    const contents = String(path).endsWith('config.toml') ? fsState.config : fsState.credentials
    if (contents === null) {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return contents
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchKimiRateLimits } from './kimi-fetcher'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

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

function hostReadPaths(kimiHome: string, tokenName = 'kimi-code'): string[] {
  return [join(kimiHome, 'config.toml'), join(kimiHome, 'credentials', `${tokenName}.json`)]
}

function freshCredentials(): string {
  return JSON.stringify({ access_token: 'tok-abc', expires_at: 99_999_999_999 })
}

describe('fetchKimiRateLimits', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fsState.config = null
    fsState.credentials = null
    fsState.readError = null
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
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps the usages payload to session (5h) and weekly windows', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('kimi')
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBeCloseTo(60)
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.weekly?.usedPercent).toBeCloseTo(0)
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')
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
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
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
    fsState.credentials = JSON.stringify({ access_token: 'tok-old', expires_at: 1 })

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
    expect(fsState.readPaths).toEqual(hostReadPaths('/home/test/.kimi-code'))
  })

  it('honors KIMI_CODE_HOME for the host home', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '/custom/kimi-home')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual(hostReadPaths('/custom/kimi-home'))
  })

  it('ignores a blank KIMI_CODE_HOME instead of reading from the process cwd', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '   ')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths).toEqual(hostReadPaths('/home/test/.kimi-code'))
  })

  // Kimi Code 2.x on auth.kimi.ai writes this and stops rotating kimi-code.json (#24176).
  it('reads the scoped OAuth slot and API base recorded in config.toml', async () => {
    fsState.config = [
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      'base_url = "https://api.kimi.ai/coding/v1"',
      '',
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      'key = "oauth/kimi-code-env-0e4f99c69cc27850"',
      'oauth_host = "https://auth.kimi.ai"'
    ].join('\n')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual(
      hostReadPaths('/home/test/.kimi-code', 'kimi-code-env-0e4f99c69cc27850')
    )
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.kimi.ai/coding/v1/usages')
  })

  it('derives the slot from the environment like the CLI, ignoring a stale oauth.key', async () => {
    fsState.config = '[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code-env-stale"'
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths).toEqual(hostReadPaths('/home/test/.kimi-code'))
  })
})
