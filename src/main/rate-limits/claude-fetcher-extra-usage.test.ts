import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { primeClaudeFetcherMocks, restorePlatform } from './claude-fetcher-test-harness'
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

function oauthPrep(): ClaudeRuntimeAuthPreparation {
  return {
    configDir: '/Users/test/.claude',
    envPatch: { CLAUDE_CONFIG_DIR: '/Users/test/.claude' },
    stripAuthEnv: false,
    provenance: 'system'
  }
}

describe('fetchClaudeRateLimits extra usage', () => {
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

  it.each([null, 42])(
    'preserves valid quota when API money currency is malformed: %s',
    async (currency) => {
      vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'oauth-token', expiresAt: Date.now() + 60_000 }
        })
      )
      netFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 10 },
            spend: { enabled: true, balance: { amount_minor: 1200, exponent: 2, currency } }
          }),
          { status: 200 }
        )
      )
      const result = await fetchClaudeRateLimits({ authPreparation: oauthPrep() })
      expect(result).toMatchObject({ status: 'ok', session: { usedPercent: 10 } })
      expect(result.extraUsage ?? null).toBeNull()
    }
  )

  it('maps the usage-credits spend object into a capped balance in major units', async () => {
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
          five_hour: { utilization: 10 },
          spend: {
            used: { amount_minor: 5000, currency: 'EUR', exponent: 2 },
            limit: { amount_minor: 200000, currency: 'EUR', exponent: 2 },
            percent: 2.5,
            enabled: true,
            balance: { amount_minor: 1000, currency: 'EUR', exponent: 2 }
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation: oauthPrep() })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: 10,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        resetsAt: null
      }
    })
  })

  it('keeps the usage-credits cap visible but disabled when out of credits', async () => {
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
          five_hour: { utilization: 10 },
          spend: {
            used: { amount_minor: 0, currency: 'EUR', exponent: 2 },
            limit: { amount_minor: 200000, currency: 'EUR', exponent: 2 },
            percent: 0,
            enabled: false,
            disabled_reason: 'out_of_credits',
            balance: null
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation: oauthPrep() })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: null,
        spent: 0,
        spendLimit: 2000,
        spentPercent: 0,
        currencyCode: 'EUR',
        enabled: false,
        disabledReason: 'out_of_credits'
      }
    })
  })

  it('keeps legacy extra_usage spend data without inventing a missing balance', async () => {
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
          five_hour: { utilization: 10 },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 200000,
            used_credits: 5000,
            utilization: 2.5,
            currency: 'EUR',
            decimal_places: 2
          }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation: oauthPrep() })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      extraUsage: {
        balance: null,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        currencyCode: 'EUR',
        enabled: true
      }
    })
  })
})
