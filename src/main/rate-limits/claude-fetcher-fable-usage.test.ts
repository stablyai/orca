import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { primeClaudeFetcherMocks, restorePlatform } from './claude-fetcher-test-harness'
import { fetchViaPty } from './claude-pty'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
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

  it('accepts Claude Code statusline-style rate limit window fields', async () => {
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
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { used_percentage: 23.5, resets_at: 1770000000 },
          seven_day: { used_percentage: 41.2, resets_at: 1770604800 },
          fable_weekly: { used_percentage: 12.3, resets_at: 1770691200 }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 23.5, resetsAt: 1770000000000 },
      weekly: { usedPercent: 41.2, resetsAt: 1770604800000 },
      fableWeekly: { usedPercent: 12.3, resetsAt: 1770691200000 }
    })
  })

  it('maps active Fable usage from the scoped OAuth limits array without a PTY read', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 36 },
          seven_day: { utilization: 73 },
          fable_weekly: { utilization: 12 },
          limits: [
            { kind: 'weekly_scoped', percent: 55, scope: null },
            {
              kind: 'weekly_scoped',
              percent: 100,
              resets_at: '2026-07-17T20:00:00.099908+00:00',
              is_active: true,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowUsagePanelSupplement: true })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      fableWeekly: {
        usedPercent: 100,
        resetsAt: Date.parse('2026-07-17T20:00:00.099908+00:00')
      },
      usageMetadata: { attemptedSources: ['oauth'] }
    })
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('surfaces inactive scoped Fable usage over the legacy OAuth fallback', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          fable_weekly: { utilization: 33 },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 90,
              is_active: false,
              scope: { model: { display_name: 'fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      fableWeekly: { usedPercent: 90 }
    })
  })

  it('surfaces an inactive scoped Fable entry when no legacy Fable field exists (#8979)', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 64,
              resets_at: '2026-07-24T20:00:00+00:00',
              is_active: false,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      fableWeekly: {
        usedPercent: 64,
        resetsAt: Date.parse('2026-07-24T20:00:00+00:00')
      }
    })
  })

  it('supplements managed-account OAuth usage with Fable from the CLI usage panel', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { used_percentage: 23.5, resets_at: 1770000000 },
          seven_day: { used_percentage: 41.2, resets_at: 1770604800 }
        }),
        { status: 200 }
      )
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: { usedPercent: 91, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      fableWeekly: {
        usedPercent: 12.3,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d 2h'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 23.5, resetsAt: 1770000000000 },
      weekly: { usedPercent: 41.2, resetsAt: 1770604800000 },
      fableWeekly: { usedPercent: 12.3, resetDescription: '3d 2h' },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli']
      }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('supplements system OAuth usage when the service explicitly allows usage-panel reads', async () => {
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
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '4d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(
      fetchClaudeRateLimits({
        authPreparation,
        allowPtyFallback: false,
        allowUsagePanelSupplement: true
      })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 },
      fableWeekly: { usedPercent: 58, resetDescription: '4d' },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli']
      }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('ignores bare Fable OAuth usage because the window length is ambiguous', async () => {
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
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          fable: { utilization: 33 }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 11 },
      weekly: { usedPercent: 22 },
      fableWeekly: null
    })
  })
})
