import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchManagedAccountUsage } from './claude-fetcher'
import {
  primeClaudeFetcherMocks,
  restorePlatform,
  setPlatform
} from './claude-fetcher-test-harness'
import { fetchViaPty } from './claude-pty'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../claude-accounts/keychain'

const {
  netFetchMock,
  tokenFetchMock,
  readFileMock,
  resolveProxyMock,
  setProxyMock,
  appGetPathMock
} = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  tokenFetchMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn(),
  appGetPathMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

// Why: the OAuth refresh goes through Node's stack, not Electron's (orca#18716).
vi.mock('undici', () => ({
  fetch: tokenFetchMock,
  EnvHttpProxyAgent: vi.fn()
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
  let tempDir: string | null = null

  beforeEach(() => {
    tempDir = null
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
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not read inactive managed credentials from unowned auth paths', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const unownedAuthPath = join(tempDir, 'unowned', 'auth')
    mkdirSync(unownedAuthPath, { recursive: true })
    writeFileSync(join(unownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(unownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'unowned-token',
          expiresAt: Date.now() + 60_000
        }
      }),
      'utf-8'
    )

    await expect(
      fetchManagedAccountUsage({ id: 'account-1', managedAuthPath: unownedAuthPath })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'No credentials'
    })

    expect(netFetchMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('supplements inactive managed account OAuth usage with Fable from its usage panel', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const canonicalAuthPath = realpathSync(ownedAuthPath)
    writeFileSync(
      join(ownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'inactive-token',
          expiresAt: Date.now() + 60_000
        }
      }),
      'utf-8'
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 42,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '2d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(
      fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: ownedAuthPath },
        { allowUsagePanelSupplement: true }
      )
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 },
      fableWeekly: { usedPercent: 42, resetDescription: '2d' }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({
      authPreparation: expect.objectContaining({
        configDir: canonicalAuthPath,
        envPatch: { CLAUDE_CONFIG_DIR: canonicalAuthPath },
        provenance: 'managed:account-1:inactive-preview',
        stripAuthEnv: true
      })
    })
  })

  it('stages macOS inactive account credentials in a scoped Keychain for Fable preview', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'managed-keychain-token',
        expiresAt: Date.now() + 60_000
      }
    })
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const canonicalAuthPath = realpathSync(ownedAuthPath)
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(credentialsJson)
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 34,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(result.fableWeekly).toMatchObject({ usedPercent: 58, resetDescription: '3d' })
    expect(writeActiveClaudeKeychainCredentials).toHaveBeenCalledWith(
      credentialsJson,
      canonicalAuthPath
    )
    expect(deleteActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(canonicalAuthPath)
  })

  it('cleans up scoped Keychain credentials when the inactive preview fails', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const canonicalAuthPath = realpathSync(ownedAuthPath)
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'managed-keychain-token' } })
    )
    vi.mocked(fetchViaPty).mockRejectedValueOnce(new Error('preview failed'))

    await expect(
      fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: ownedAuthPath },
        { allowUsagePanelSupplement: true }
      )
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 },
      fableWeekly: null
    })

    expect(deleteActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(canonicalAuthPath)
  })

  it('stages refreshed macOS inactive account credentials before Fable preview', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const staleCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        expiresAt: Date.now() - 60_000
      }
    })
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(staleCredentialsJson)
    tokenFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          expires_in: 3600,
          refresh_token: 'fresh-refresh'
        }),
        { status: 200 }
      )
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }),
        {
          status: 200
        }
      )
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 34,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    const stagedCredentialsJson = vi.mocked(writeActiveClaudeKeychainCredentials).mock.calls[0]?.[0]
    expect(result.fableWeekly).toMatchObject({ usedPercent: 58, resetDescription: '3d' })
    expect(JSON.parse(stagedCredentialsJson ?? '{}')).toMatchObject({
      claudeAiOauth: {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh'
      }
    })
    expect(writeManagedClaudeKeychainCredentials).toHaveBeenCalledWith(
      'account-1',
      stagedCredentialsJson
    )
  })

  it('does not merge macOS inactive Fable preview when usage windows belong to another account', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'managed-keychain-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 91,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 3,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(result.fableWeekly).toBeNull()
  })

  it('refreshes and persists an expiring inactive account before fetching usage', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const credentialsPath = join(ownedAuthPath, '.credentials.json')
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stale-access',
          refreshToken: 'stale-refresh',
          expiresAt: Date.now() - 60_000
        }
      }),
      'utf-8'
    )

    // The OAuth refresh (token endpoint) goes through Node fetch; the usage
    // fetch with the refreshed access token still goes through net.fetch.
    tokenFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    })
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } })
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('ok')
    // Rotated token persisted back to managed storage.
    const persisted = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    expect(persisted.claudeAiOauth.accessToken).toBe('fresh-access')
    expect(persisted.claudeAiOauth.refreshToken).toBe('fresh-refresh')
    // Usage fetch used the fresh access token.
    const usageCall = netFetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/oauth/usage')
    )
    expect(usageCall?.[1]?.headers?.Authorization).toBe('Bearer fresh-access')
  })

  function writeOwnedInactiveAccount(oauth: Record<string, unknown>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(ownedAuthPath, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: oauth }),
      'utf-8'
    )
    return ownedAuthPath
  }

  it('returns a classified error row instead of throwing when the usage endpoint rejects the token', async () => {
    setPlatform('linux')
    const ownedAuthPath = writeOwnedInactiveAccount({
      accessToken: 'valid-access',
      refreshToken: 'valid-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000
    })
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 })
    )

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.usageMetadata?.attemptedSources).toEqual(['oauth'])
    expect(tokenFetchMock).not.toHaveBeenCalled()
  })

  it('marks a 429 as rate-limited with a retry-at instead of a silent gap', async () => {
    setPlatform('linux')
    const ownedAuthPath = writeOwnedInactiveAccount({
      accessToken: 'valid-access',
      refreshToken: 'valid-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000
    })
    netFetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '60' } })
    )

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThan(Date.now())
  })

  it('asks for a new login when the refresh token is dead, without spending a usage call', async () => {
    setPlatform('linux')
    const ownedAuthPath = writeOwnedInactiveAccount({
      accessToken: 'stale-access',
      refreshToken: 'dead-refresh',
      expiresAt: Date.now() - 60_000
    })
    tokenFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      body: { cancel: async () => undefined },
      json: async () => ({ error: 'invalid_grant' })
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('reauth-required')
    expect(result.usageMetadata?.authProvenance).toBe('managed:account-1')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reports the refresh failure instead of sending an already-expired token', async () => {
    setPlatform('linux')
    const ownedAuthPath = writeOwnedInactiveAccount({
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
      expiresAt: Date.now() - 60_000
    })
    tokenFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      body: { cancel: async () => undefined },
      json: async () => ({})
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('still tries the stored token when the refresh fails transiently inside the expiry buffer', async () => {
    setPlatform('linux')
    const ownedAuthPath = writeOwnedInactiveAccount({
      accessToken: 'still-accepted',
      refreshToken: 'valid-refresh',
      // Within the 5-minute refresh buffer, but not expired yet.
      expiresAt: Date.now() + 2 * 60_000
    })
    tokenFetchMock.mockRejectedValueOnce(new Error('fetch failed'))
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }),
        {
          status: 200
        }
      )
    )

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('ok')
    expect(netFetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer still-accepted')
  })
})
