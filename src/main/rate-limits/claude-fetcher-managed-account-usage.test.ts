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
      error: 'No credentials',
      usageMetadata: { failureKind: 'missing-credentials' }
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
    netFetchMock.mockResolvedValueOnce(
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

    // First net.fetch call is the OAuth refresh (token endpoint); second is the
    // usage fetch with the refreshed access token.
    netFetchMock.mockResolvedValueOnce({
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

  it('returns a classified error when inactive OAuth usage is rejected', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(ownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-access',
          refreshToken: 'stale-refresh',
          expiresAt: Date.now() - 60_000
        }
      }),
      'utf-8'
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'OAuth access token has expired. Re-authenticate to continue.' }
        }),
        { status: 401 }
      )
    )

    await expect(
      fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: ownedAuthPath },
        { allowUsagePanelSupplement: true }
      )
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      session: null,
      weekly: null,
      error: 'OAuth access token has expired. Re-authenticate to continue.',
      usageMetadata: {
        failureKind: 'stale-token',
        attemptedSources: ['oauth'],
        authProvenance: 'managed:account-1:inactive-preview'
      }
    })
    expect(fetchViaPty).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes once after a 401 whose access token is not yet expired and then reads windows', async () => {
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
          accessToken: 'soon-stale-access',
          refreshToken: 'still-valid-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: ['user:inference', 'user:profile']
        }
      }),
      'utf-8'
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'OAuth access token has expired. Re-authenticate to continue.' }
        }),
        { status: 401 }
      )
    )
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'fresh-access',
        expires_in: 3600,
        refresh_token: 'fresh-refresh'
      })
    })
    netFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour: { utilization: 16 }, seven_day: { utilization: 20 } })
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(16)
    expect(result.weekly?.usedPercent).toBe(20)
    expect(netFetchMock).toHaveBeenCalledTimes(3)
    const usageCall = netFetchMock.mock.calls.find(
      ([url], index) => String(url).includes('/api/oauth/usage') && index > 0
    )
    expect(usageCall?.[1]?.headers?.Authorization).toBe('Bearer fresh-access')
    expect(fetchViaPty).not.toHaveBeenCalled()
    const persisted = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    expect(persisted.claudeAiOauth.accessToken).toBe('fresh-access')
  })

  it('keeps a refresh token selection already rotated during a stale 401', async () => {
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
          accessToken: 'soon-stale-access',
          refreshToken: 'still-valid-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: ['user:inference', 'user:profile']
        }
      }),
      'utf-8'
    )
    const rotatedBySelection = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rotated-by-selection',
        refreshToken: 'rotated-by-selection-refresh',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile']
      }
    })
    let usageCalls = 0
    netFetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url)
      if (!target.includes('/api/oauth/usage')) {
        throw new Error(`token endpoint must not be called: ${target}`)
      }
      usageCalls += 1
      if (usageCalls === 1) {
        writeFileSync(credentialsPath, rotatedBySelection, 'utf-8')
        return new Response(
          JSON.stringify({
            error: { message: 'OAuth access token has expired. Re-authenticate to continue.' }
          }),
          { status: 401 }
        )
      }
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization: 11 }, seven_day: { utilization: 22 } })
      }
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(11)
    expect(result.weekly?.usedPercent).toBe(22)
    expect(usageCalls).toBe(2)
    const secondUsage = netFetchMock.mock.calls.find(
      ([url], index) => String(url).includes('/api/oauth/usage') && index > 0
    )
    expect(secondUsage?.[1]?.headers?.Authorization).toBe('Bearer rotated-by-selection')
    expect(fetchViaPty).not.toHaveBeenCalled()
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(rotatedBySelection)
  })

  it('keeps a newer access token when selection kept the same refresh token', async () => {
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
          accessToken: 'soon-stale-access',
          refreshToken: 'still-valid-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: ['user:inference', 'user:profile']
        }
      }),
      'utf-8'
    )
    const rotatedBySelection = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rotated-by-selection',
        refreshToken: 'still-valid-refresh',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile']
      }
    })
    let usageCalls = 0
    netFetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url)
      if (!target.includes('/api/oauth/usage')) {
        throw new Error(`token endpoint must not be called: ${target}`)
      }
      usageCalls += 1
      if (usageCalls === 1) {
        writeFileSync(credentialsPath, rotatedBySelection, 'utf-8')
        return new Response(
          JSON.stringify({
            error: { message: 'OAuth access token has expired. Re-authenticate to continue.' }
          }),
          { status: 401 }
        )
      }
      return {
        ok: true,
        json: async () => ({ five_hour: { utilization: 9 }, seven_day: { utilization: 18 } })
      }
    })

    const result = await fetchManagedAccountUsage({
      id: 'account-1',
      managedAuthPath: ownedAuthPath
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(9)
    expect(result.weekly?.usedPercent).toBe(18)
    expect(usageCalls).toBe(2)
    const secondUsage = netFetchMock.mock.calls.find(
      ([url], index) => String(url).includes('/api/oauth/usage') && index > 0
    )
    expect(secondUsage?.[1]?.headers?.Authorization).toBe('Bearer rotated-by-selection')
    expect(fetchViaPty).not.toHaveBeenCalled()
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(rotatedBySelection)
  })
})
