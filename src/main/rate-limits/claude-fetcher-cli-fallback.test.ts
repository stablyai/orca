import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('does not mask OAuth usage rate limits with the PTY fallback', async () => {
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
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.'
          }
        }),
        { status: 429, headers: { 'retry-after': '3000' } }
      )
    )

    const before = Date.now()
    const result = await fetchClaudeRateLimits({ authPreparation })
    expect(result).toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude usage is rate limited right now.',
      usageMetadata: expect.objectContaining({ failureKind: 'rate-limited' })
    })
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3000 * 1000)
    expect(result.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 3000 * 1000)

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer expired-oauth-token'
        })
      })
    )
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('omits retryAtMs when a 429 has no Retry-After header', async () => {
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
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.'
          }
        }),
        { status: 429 }
      )
    )

    const result = await fetchClaudeRateLimits({ authPreparation })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('uses CLI fallback for OAuth auth failures when automatic repair is safe', async () => {
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
          accessToken: 'stale-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Invalid OAuth token.'
          }
        }),
        { status: 401 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['oauth', 'cli']
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('re-reads credentials and retries OAuth once after CLI repair', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'stale-oauth-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() - 60_000
          }
        })
      )
      // Legacy item absent — the stale-scoped legacy fallback must not preempt
      // CLI repair in this scenario.
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'repaired-oauth-token',
            refreshToken: 'refresh-token-2',
            expiresAt: Date.now() + 60_000
          }
        })
      )
    netFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: 'authentication_error',
              message: 'Invalid OAuth token.'
            }
          }),
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 14 },
            seven_day: { utilization: 27 }
          }),
          { status: 200 }
        )
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 14 },
      weekly: { usedPercent: 27 },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli'],
        credentialSource: 'scoped-keychain'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer repaired-oauth-token'
        })
      })
    )
  })

  it('explains auth failures when a live Claude terminal owns managed refresh', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      managedRefreshDeferredByLivePty: true,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stale-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Invalid OAuth token.'
          }
        }),
        { status: 401 }
      )
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start CLI fallback when live Claude owns managed refresh and no token is readable', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      managedRefreshDeferredByLivePty: true,
      provenance: 'managed:account-1'
    }

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.',
      usageMetadata: {
        failureKind: 'deferred-by-live-session',
        deferredByLiveClaudeSession: true,
        attemptedSources: []
      }
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start the PTY fallback when disabled for background fetches', async () => {
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
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'OAuth API returned 500'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start the PTY fallback for refresh-only credentials when disabled', async () => {
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
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude OAuth access token unavailable'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('falls back to CLI when OAuth credentials are missing in automatic mode', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('marks CLI plan usage shell results as usage unavailable', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'Claude plan usage is unavailable for this Claude CLI session.',
      status: 'error'
    })

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude plan usage is unavailable for this Claude CLI session.',
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        failureKind: 'usage-unavailable'
      }
    })
  })

  it('surfaces Keychain read failures as structured usage metadata when CLI fallback is disabled', async () => {
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValueOnce(
      new Error('security timed out after 3000ms')
    )

    await expect(fetchClaudeRateLimits({ allowPtyFallback: false })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude Keychain credentials unavailable',
      usageMetadata: {
        failureKind: 'keychain-unavailable',
        attemptedSources: [],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('uses CLI fallback when Keychain is unavailable in automatic mode', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValueOnce(
      new Error('security timed out after 3000ms')
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })
})
