import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { primeClaudeFetcherMocks, restorePlatform } from './claude-fetcher-test-harness'
import { refreshClaudeLoginViaCli } from './claude-cli-login-refresh'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type * as CodexCliCommand from '../codex-cli/command'
import type { ClaudeCliLoginRefreshPermit } from './claude-usage-fetch-options'

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

vi.mock('./claude-cli-login-refresh', () => ({
  refreshClaudeLoginViaCli: vi.fn()
}))

vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCliCommand>()),
  resolveClaudeCommand: () => '/fake/bin/claude'
}))

vi.mock('../claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

const configDir = '/Users/test/.claude'

function systemAuth(): ClaudeRuntimeAuthPreparation {
  return { configDir, envPatch: {}, stripAuthEnv: false, provenance: 'system' }
}

function managedAuth(
  overrides: Partial<ClaudeRuntimeAuthPreparation> = {}
): ClaudeRuntimeAuthPreparation {
  return {
    configDir,
    envPatch: {},
    stripAuthEnv: true,
    provenance: 'managed:account-1',
    ...overrides
  }
}

// The login this fetch was prepared for is still the selected one.
function refreshPermit(): ClaudeCliLoginRefreshPermit {
  return { readCurrentAuthProvenance: () => 'managed:account-1' }
}

function storedLogin(accessToken: string | undefined, expiresInMs = -60_000): string {
  return JSON.stringify({
    claudeAiOauth: {
      ...(accessToken ? { accessToken } : {}),
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + expiresInMs
    }
  })
}

function usageError(status: number, type: string): Response {
  return new Response(JSON.stringify({ error: { type, message: 'nope' } }), { status })
}

function usage(session: number, weekly: number): Response {
  return new Response(
    JSON.stringify({ five_hour: { utilization: session }, seven_day: { utilization: weekly } }),
    { status: 200 }
  )
}

describe('fetchClaudeRateLimits without a hidden interactive Claude', () => {
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

  it('does not mask OAuth usage rate limits with a CLI refresh', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin('expired-oauth-token')
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
        status: 429,
        headers: { 'retry-after': '3000' }
      })
    )

    const before = Date.now()
    const result = await fetchClaudeRateLimits({
      authPreparation: managedAuth(),
      cliLoginRefresh: refreshPermit()
    })
    expect(result).toMatchObject({
      status: 'error',
      error: 'Claude usage is rate limited right now.',
      usageMetadata: expect.objectContaining({ failureKind: 'rate-limited' })
    })
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3000 * 1000)
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('omits retryAtMs when a 429 has no Retry-After header', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin('expired-oauth-token')
    )
    netFetchMock.mockResolvedValueOnce(usageError(429, 'rate_limit_error'))

    const result = await fetchClaudeRateLimits({ authPreparation: systemAuth() })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
  })

  it('lets a managed account’s own Claude refresh an expired login, then reads usage with it', async () => {
    const authPreparation = managedAuth()
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(storedLogin('stale-oauth-token'))
      .mockResolvedValueOnce(storedLogin('refreshed-oauth-token', 60_000))
    netFetchMock.mockResolvedValueOnce(usageError(401, 'authentication_error'))
    netFetchMock.mockResolvedValueOnce(usage(14, 27))

    await expect(
      fetchClaudeRateLimits({ authPreparation, cliLoginRefresh: refreshPermit() })
    ).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 14 },
      weekly: { usedPercent: 27 },
      usageMetadata: { source: 'oauth', attemptedSources: ['oauth', 'cli'] }
    })
    expect(refreshClaudeLoginViaCli).toHaveBeenCalledWith(
      expect.objectContaining({ authPreparation })
    )
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer refreshed-oauth-token' })
      })
    )
  })

  it('says the user must renew the login, and backs off, when Claude saved nothing new', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValue(usageError(401, 'authentication_error'))
    const options = { authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() }

    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'delegated-refresh-required' }
    })
    // Still true during the backoff: nothing is renewing the login.
    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      usageMetadata: { failureKind: 'delegated-refresh-required' }
    })

    // The usage answer is never trusted: only the stored login decides, so one probe per backoff.
    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(1)
  })

  it('does not back off when Claude was never started', async () => {
    vi.mocked(refreshClaudeLoginViaCli).mockResolvedValue({
      kind: 'not-started',
      message: 'the selected Claude account changed'
    })
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValue(usageError(401, 'authentication_error'))
    const options = { authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() }

    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'stale-token' }
    })
    await fetchClaudeRateLimits(options)

    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(2)
  })

  it('backs off when Claude started but exited before answering', async () => {
    vi.mocked(refreshClaudeLoginViaCli).mockResolvedValue({
      kind: 'failed',
      message: 'claude stream-json exited (code 1)'
    })
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValue(usageError(401, 'authentication_error'))
    const options = { authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() }

    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      usageMetadata: { failureKind: 'delegated-refresh-required' }
    })
    await fetchClaudeRateLimits(options)

    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(1)
  })

  it('reports Claude as unavailable, and backs off, when its binary cannot be launched', async () => {
    vi.mocked(refreshClaudeLoginViaCli).mockResolvedValue({
      kind: 'not-launched',
      message: 'spawn /fake/bin/claude ENOENT'
    })
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValue(usageError(401, 'authentication_error'))
    const options = { authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() }

    // Claude never ran, so nothing was learned about the login.
    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'cli-unavailable' }
    })
    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      usageMetadata: { failureKind: 'cli-unavailable' }
    })

    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(1)
  })

  it('does not start a CLI that lacks get_usage again', async () => {
    vi.mocked(refreshClaudeLoginViaCli).mockResolvedValue({
      kind: 'unsupported',
      message: 'Unsupported control request subtype: get_usage'
    })
    // A changed login does not lift the per-binary latch.
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(storedLogin('stale-oauth-token'))
      .mockResolvedValueOnce(storedLogin('other-stale-token'))
    netFetchMock.mockResolvedValue(usageError(401, 'authentication_error'))
    const options = { authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() }

    await fetchClaudeRateLimits(options)
    await expect(fetchClaudeRateLimits(options)).resolves.toMatchObject({
      usageMetadata: { failureKind: 'delegated-refresh-required' }
    })

    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(1)
  })

  it('never starts Claude for a system-default login', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValueOnce(usageError(401, 'authentication_error'))

    await expect(fetchClaudeRateLimits({ authPreparation: systemAuth() })).resolves.toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'stale-token' }
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('reports a server error instead of asking the CLI, which calls the same endpoint', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin('oauth-token', 60_000)
    )
    netFetchMock.mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))

    await expect(
      fetchClaudeRateLimits({ authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() })
    ).resolves.toMatchObject({ status: 'error', error: 'OAuth API returned 500' })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('explains auth failures when a live Claude terminal owns managed refresh', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin('stale-oauth-token')
    )
    netFetchMock.mockResolvedValueOnce(usageError(401, 'authentication_error'))

    await expect(
      fetchClaudeRateLimits({
        authPreparation: managedAuth({ managedRefreshDeferredByLivePty: true }),
        cliLoginRefresh: refreshPermit()
      })
    ).resolves.toMatchObject({
      status: 'error',
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('waits for a live Claude when no token is readable', async () => {
    await expect(
      fetchClaudeRateLimits({
        authPreparation: managedAuth({ managedRefreshDeferredByLivePty: true }),
        cliLoginRefresh: refreshPermit()
      })
    ).resolves.toMatchObject({
      status: 'error',
      usageMetadata: {
        failureKind: 'deferred-by-live-session',
        deferredByLiveClaudeSession: true,
        attemptedSources: []
      }
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('refreshes refresh-only credentials through the CLI when allowed', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(storedLogin(undefined))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storedLogin('refreshed-oauth-token', 60_000))

    await expect(
      fetchClaudeRateLimits({ authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() })
    ).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 12 } })
    expect(refreshClaudeLoginViaCli).toHaveBeenCalledTimes(1)
  })

  it('reports refresh-only credentials when the CLI refresh is not allowed', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      storedLogin(undefined)
    )

    await expect(fetchClaudeRateLimits({ authPreparation: systemAuth() })).resolves.toMatchObject({
      status: 'error',
      error: 'Claude OAuth access token unavailable'
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('shows a signed-out managed account as an error, never by starting Claude', async () => {
    await expect(
      fetchClaudeRateLimits({ authPreparation: managedAuth(), cliLoginRefresh: refreshPermit() })
    ).resolves.toMatchObject({
      status: 'error',
      error: 'Claude account is signed out',
      usageMetadata: { failureKind: 'missing-credentials', attemptedSources: [] }
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })

  it('keeps API-key billing wording for a system login with no subscription credentials', async () => {
    await expect(fetchClaudeRateLimits({ authPreparation: systemAuth() })).resolves.toMatchObject({
      status: 'unavailable',
      error: 'No subscription plan — API key billing',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  })

  it('surfaces an unreadable Keychain without starting Claude, which reads it the same way', async () => {
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValueOnce(
      new Error('security timed out after 3000ms')
    )

    await expect(
      fetchClaudeRateLimits({ cliLoginRefresh: refreshPermit() })
    ).resolves.toMatchObject({
      status: 'error',
      error: 'Claude Keychain credentials unavailable',
      usageMetadata: { failureKind: 'keychain-unavailable', attemptedSources: [] }
    })
    expect(refreshClaudeLoginViaCli).not.toHaveBeenCalled()
  })
})
