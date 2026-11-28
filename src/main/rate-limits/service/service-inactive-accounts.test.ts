import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { RateLimitService } from './rate-limit-service'

const { accountUsagePreparations } = vi.hoisted(() => ({
  accountUsagePreparations: new Map<
    string,
    {
      configDir: string
      home?: string
      provenance: 'system'
      envPatch: Record<string, string>
      readingAccount?: unknown
    }
  >()
}))

vi.mock('../../claude-accounts/profiles/routing/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    accountUsagePreparation: (accountId: string) => accountUsagePreparations.get(accountId) ?? null,
    userConfigDir: () => '/system',
    accountConfigDir: (accountId: string) => `/accounts/${accountId}`
  }),
  getClaudeWslProfileRouter: () => null
}))
vi.mock('../../claude-accounts/profiles/claude-profile-paths', () => ({
  readUserClaudeConfigDir: () => '/system'
}))
vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/codex/codex-fetcher', () => ({ fetchCodexRateLimits: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(fetchActiveClaudeRateLimits).mockReset()
})

const ACCOUNT_ID = 'account-a'

function rateLimited(retryAfterMs: number): ProviderRateLimits {
  // The fetcher turns a 429 into this result: failureKind plus the Retry-After it stored.
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'OAuth usage request was rate limited. Try again later.',
    status: 'error',
    usageMetadata: {
      failureKind: 'rate-limited',
      attemptedSources: ['oauth'],
      retryAtMs: Date.now() + retryAfterMs
    }
  }
}

function okUsage(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

function serviceWithInactiveAccount(): RateLimitService {
  accountUsagePreparations.set(ACCOUNT_ID, {
    configDir: `/accounts/${ACCOUNT_ID}`,
    provenance: 'system',
    envPatch: { CLAUDE_CONFIG_DIR: `/accounts/${ACCOUNT_ID}` }
  })
  const service = new RateLimitService()
  service.setInactiveClaudeAccountsResolver(() => [{ id: ACCOUNT_ID }])
  return service
}

it('retries an inactive account on a manual open even while its Retry-After is active', async () => {
  vi.useFakeTimers()
  const start = Date.parse('2026-11-24T00:00:00Z')
  vi.setSystemTime(start)
  const fetchUsage = vi.mocked(fetchActiveClaudeRateLimits)
  fetchUsage.mockResolvedValueOnce(rateLimited(30 * 60 * 1000))
  const service = serviceWithInactiveAccount()

  try {
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchUsage).toHaveBeenCalledTimes(1)

    // The 429 parked the account: an automatic open stays gated for its whole retry window.
    vi.setSystemTime(start + 6 * 60 * 1000)
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchUsage).toHaveBeenCalledTimes(1)

    // Opening the switcher is the user asking now; it must not wait out the parked window.
    fetchUsage.mockResolvedValueOnce(okUsage(42))
    await service.fetchInactiveClaudeAccountsOnOpen('manual')
    expect(fetchUsage).toHaveBeenCalledTimes(2)

    const state = await service.getState()
    expect(state.inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(42)
  } finally {
    service.stop()
  }
})

it('lets a manual open through the debounce while an automatic open keeps it', async () => {
  vi.useFakeTimers()
  const start = Date.parse('2026-11-24T00:00:00Z')
  vi.setSystemTime(start)
  const fetchUsage = vi.mocked(fetchActiveClaudeRateLimits)
  fetchUsage.mockResolvedValue(okUsage(10))
  const service = serviceWithInactiveAccount()

  try {
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchUsage).toHaveBeenCalledTimes(1)

    // Reopening the switcher within the minute is the user asking again; it must not be debounced.
    vi.setSystemTime(start + 30 * 1000)
    await service.fetchInactiveClaudeAccountsOnOpen('manual')
    expect(fetchUsage).toHaveBeenCalledTimes(2)

    // The automated path still keeps its one-minute debounce so a reopening renderer cannot burst.
    vi.setSystemTime(start + 60 * 1000)
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchUsage).toHaveBeenCalledTimes(2)

    vi.setSystemTime(start + 91 * 1000)
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchUsage).toHaveBeenCalledTimes(3)
  } finally {
    service.stop()
  }
})
