import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { primeClaudeFetcherMocks, restorePlatform } from './claude-fetcher-test-harness'
import { fetchViaPty } from './claude-pty'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const { netFetchMock, readFileMock, resolveProxyMock, setProxyMock, appGetPathMock } = vi.hoisted(
  () => ({
    netFetchMock: vi.fn(),
    readFileMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn(),
    appGetPathMock: vi.fn()
  })
)

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  },
  net: {
    fetch: netFetchMock
  },
  session: {
    defaultSession: {
      resolveProxy: resolveProxyMock,
      setProxy: setProxyMock
    }
  }
}))

vi.mock('./claude-pty', () => ({
  fetchViaPty: vi.fn()
}))

vi.mock('../claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

describe('fetchClaudeRateLimits', () => {
  beforeEach(() => {
    primeClaudeFetcherMocks({
      netFetchMock,
      readFileMock,
      resolveProxyMock,
      setProxyMock,
      appGetPathMock
    })
  })

  afterEach(() => {
    restorePlatform()
  })

  it('does not read host credentials when WSL config resolution fails', async () => {
    await expect(
      fetchClaudeRateLimits({
        authPreparation: {
          configDir: '/Users/test/.claude',
          runtime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxConfigDir: null,
          envPatch: {},
          stripAuthEnv: true,
          provenance: 'wsl:Ubuntu:system'
        }
      })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'WSL Claude config unavailable for Ubuntu'
    })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('reads scoped Keychain credentials when the Claude config dir is explicit', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(configDir)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'User-Agent': 'claude-code/2.1.0'
        })
      })
    )
  })

  it('falls back to the legacy keychain token when the scoped token is rejected as stale', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({
            claudeAiOauth: { accessToken: 'stale-scoped-token', refreshToken: 'refresh-1' }
          })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )
    netFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      return auth === 'Bearer fresh-legacy-token'
        ? new Response(
            JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }),
            { status: 200 }
          )
        : new Response(
            JSON.stringify({ error: { message: 'Invalid authentication credentials' } }),
            { status: 401 }
          )
    })

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('prefers a legacy access token over scoped refresh-only credentials', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only' } })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 }
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-legacy-token' })
      })
    )
  })

  it('does not retry with the legacy keychain for managed account credentials', async () => {
    const configDir = '/Users/test/managed-account'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: true,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir ? JSON.stringify({ claudeAiOauth: { accessToken: 'stale-managed-token' } }) : null
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalledWith(undefined)
  })

  it('does not retry with the legacy keychain for WSL targets', async () => {
    // Why: a WSL target's stale credentials must never be answered with the
    // host user's legacy macOS Keychain account.
    const configDir = '\\\\wsl$\\Ubuntu\\home\\test\\.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: '/home/test/.claude',
      envPatch: { CLAUDE_CONFIG_DIR: '/home/test/.claude' },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'stale-wsl-token' } })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalledWith(undefined)
  })

  it('skips the legacy retry when the legacy item mirrors the failed scoped token', async () => {
    // Why: Claude's usage endpoint has a tight request budget; retrying the
    // identical token would double the request for a guaranteed second 401.
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'mirrored-token' } })
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(undefined)
  })

  it('falls back to legacy Keychain credentials for host system default without an explicit config dir', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'host',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'legacy-oauth-token',
            expiresAt: Date.now() + 60_000
          }
        })
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(1, configDir)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2, undefined)
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-oauth-token'
        })
      })
    )
  })

  it('reads scoped Keychain credentials for host system default without an explicit config dir', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'host',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'scoped-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(configDir)
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer scoped-oauth-token'
        })
      })
    )
  })

  it('falls back to the credentials file when Keychain access fails', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockRejectedValue(
      new Error('Keychain locked')
    )
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok'
    })

    expect(readFileMock).toHaveBeenCalledWith(
      join('/Users/test/.claude', '.credentials.json'),
      'utf-8'
    )
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer file-oauth-token'
        })
      })
    )
  })

  it('falls back to legacy Keychain when scoped credentials are unusable', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce('{not-json')
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'legacy-oauth-token',
            expiresAt: Date.now() + 60_000
          }
        })
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok'
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(1, configDir)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2, undefined)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-oauth-token'
        })
      })
    )
  })

  it('tries OAuth usage even when local credential metadata is expired', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 }
    })

    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer expired-oauth-token'
        })
      })
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })
})
