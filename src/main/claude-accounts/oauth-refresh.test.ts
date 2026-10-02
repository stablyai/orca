import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRefreshedToken,
  isOauthTokenExpiring,
  parseClaudeOauthBlob,
  readRefreshToken,
  refreshClaudeOauthCredentials
} from './oauth-refresh'

const { fetchMock, envHttpProxyAgentMock, dispatcherCloseMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  envHttpProxyAgentMock: vi.fn(),
  dispatcherCloseMock: vi.fn().mockResolvedValue(undefined)
}))

// Why: the token endpoint refuses Chromium's stack (orca#18716); the refresh
// must never go through Electron's net.fetch again.
vi.mock('electron', () => ({
  net: {
    fetch: () => {
      throw new Error('refresh must not use electron net.fetch')
    }
  }
}))

vi.mock('undici', () => ({
  fetch: fetchMock,
  EnvHttpProxyAgent: envHttpProxyAgentMock
}))

const NOW = 1_700_000_000_000

function credentials(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'],
      ...overrides
    }
  })
}

describe('parseClaudeOauthBlob', () => {
  it('returns the oauth block', () => {
    expect(parseClaudeOauthBlob(credentials())?.accessToken).toBe('old-access')
  })

  it('returns null for non-JSON or missing block', () => {
    expect(parseClaudeOauthBlob('not json')).toBeNull()
    expect(parseClaudeOauthBlob('{}')).toBeNull()
    expect(parseClaudeOauthBlob('{"claudeAiOauth":[]}')).toBeNull()
  })
})

describe('readRefreshToken', () => {
  it('reads a present token', () => {
    expect(readRefreshToken(credentials())).toBe('old-refresh')
  })

  it('returns null for blank or missing tokens', () => {
    expect(readRefreshToken(credentials({ refreshToken: '   ' }))).toBeNull()
    expect(readRefreshToken(credentials({ refreshToken: undefined }))).toBeNull()
  })
})

describe('isOauthTokenExpiring', () => {
  it('is false when well within validity', () => {
    expect(isOauthTokenExpiring(credentials(), NOW)).toBe(false)
  })

  it('is true within the 5-minute buffer', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: NOW + 60 * 1000 }), NOW)).toBe(true)
  })

  it('is true when already expired', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: NOW - 1000 }), NOW)).toBe(true)
  })

  it('treats missing/non-numeric expiry as expiring', () => {
    expect(isOauthTokenExpiring(credentials({ expiresAt: undefined }), NOW)).toBe(true)
    expect(isOauthTokenExpiring(credentials({ expiresAt: 'soon' }), NOW)).toBe(true)
  })

  it('is false for credentials without an oauth block', () => {
    expect(isOauthTokenExpiring('{}', NOW)).toBe(false)
  })
})

describe('applyRefreshedToken', () => {
  it('rotates access + refresh token and recomputes expiry', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' },
      NOW
    )
    const oauth = parseClaudeOauthBlob(updated!)!
    expect(oauth.accessToken).toBe('new-access')
    expect(oauth.refreshToken).toBe('new-refresh')
    expect(oauth.expiresAt).toBe(NOW + 3600 * 1000)
  })

  it('keeps the existing refresh token when the server does not rotate it', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'new-access', expires_in: 3600 },
      NOW
    )
    expect(parseClaudeOauthBlob(updated!)!.refreshToken).toBe('old-refresh')
  })

  it('preserves unrelated top-level fields', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r' },
      somethingElse: { keep: true }
    })
    const updated = applyRefreshedToken(raw, { access_token: 'b' }, NOW)
    expect(JSON.parse(updated!).somethingElse).toEqual({ keep: true })
  })

  it('splits scope string into scopes array', () => {
    const updated = applyRefreshedToken(
      credentials(),
      { access_token: 'b', scope: 'user:inference user:profile' },
      NOW
    )
    expect(parseClaudeOauthBlob(updated!)!.scopes).toEqual(['user:inference', 'user:profile'])
  })

  it('returns null when the response lacks an access token', () => {
    expect(applyRefreshedToken(credentials(), {}, NOW)).toBeNull()
    expect(applyRefreshedToken('not json', { access_token: 'b' }, NOW)).toBeNull()
  })
})

describe('refreshClaudeOauthCredentials', () => {
  const NO_PROXY_ENV = {}

  beforeEach(() => {
    vi.clearAllMocks()
    envHttpProxyAgentMock.mockImplementation(
      function (this: { close: typeof dispatcherCloseMock }) {
        this.close = dispatcherCloseMock
      }
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function okResponse(): { ok: true; json: () => Promise<Record<string, unknown>> } {
    return {
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    }
  }

  it('returns null without a refresh token (no network call)', async () => {
    const result = await refreshClaudeOauthCredentials(credentials({ refreshToken: undefined }), {
      now: NOW,
      env: NO_PROXY_ENV
    })
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a form-urlencoded refresh grant through Node fetch and persists the rotation', async () => {
    fetchMock.mockResolvedValue(okResponse())

    const result = await refreshClaudeOauthCredentials(credentials(), {
      now: NOW,
      env: NO_PROXY_ENV
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(init.body)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(body.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(init.dispatcher).toBeUndefined()
    expect(envHttpProxyAgentMock).not.toHaveBeenCalled()

    const oauth = parseClaudeOauthBlob(result!)!
    expect(oauth.accessToken).toBe('fresh-access')
    expect(oauth.refreshToken).toBe('fresh-refresh')
  })

  it('tunnels through the shell proxy with its NO_PROXY list', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await refreshClaudeOauthCredentials(credentials(), {
      now: NOW,
      env: { HTTPS_PROXY: 'http://user:pw@proxy.corp:3128', NO_PROXY: 'localhost,.corp' }
    })

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: 'http://user:pw@proxy.corp:3128',
      httpsProxy: 'http://user:pw@proxy.corp:3128',
      noProxy: 'localhost,.corp'
    })
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(envHttpProxyAgentMock)
    expect(dispatcherCloseMock).toHaveBeenCalledTimes(1)
  })

  it("prefers Orca's configured proxy over the shell's and replaces NO_PROXY with its bypass rules", async () => {
    fetchMock.mockResolvedValue(okResponse())

    await refreshClaudeOauthCredentials(credentials(), {
      now: NOW,
      env: { HTTPS_PROXY: 'http://shell-proxy:8080', NO_PROXY: 'localhost' },
      networkProxySettings: {
        httpProxyUrl: 'http://orca-proxy:9090',
        httpProxyBypassRules: '*.internal;10.0.0.0/8'
      }
    })

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: 'http://orca-proxy:9090',
      httpsProxy: 'http://orca-proxy:9090',
      noProxy: '*.internal,10.0.0.0/8'
    })
  })

  it('refuses to bypass a SOCKS proxy: no request, null result, warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await refreshClaudeOauthCredentials(credentials(), {
      now: NOW,
      env: { ALL_PROXY: 'socks5://proxy.corp:1080' }
    })

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(envHttpProxyAgentMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socks5: proxies are not supported'))
    warn.mockRestore()
  })

  it('settles as soon as the caller aborts, without waiting for the request timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )

    const pending = refreshClaudeOauthCredentials(credentials(), {
      now: NOW,
      env: NO_PROXY_ENV,
      signal: controller.signal
    })
    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    warn.mockRestore()
  })

  it('returns null on a non-ok response, logs the status, and drains the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cancel = vi.fn().mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      body: { cancel },
      json: async () => ({})
    })
    expect(
      await refreshClaudeOauthCredentials(credentials(), { now: NOW, env: NO_PROXY_ENV })
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'))
    expect(cancel).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('returns null when the request throws (never rejects) and still closes the dispatcher', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    await expect(
      refreshClaudeOauthCredentials(credentials(), {
        now: NOW,
        env: { HTTPS_PROXY: 'http://proxy.corp:3128' }
      })
    ).resolves.toBeNull()
    expect(dispatcherCloseMock).toHaveBeenCalledTimes(1)
  })
})
