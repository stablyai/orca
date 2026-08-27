import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomProviderAccount } from '../../shared/custom-provider-types'
import { RateLimitService } from './service'
import { fetchCustomProviderUsage } from './custom-provider-fetcher'
import { resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('./custom-provider-fetcher', () => ({
  fetchCustomProviderUsage: vi.fn()
}))

function makeAccount(overrides: Partial<CustomProviderAccount> = {}): CustomProviderAccount {
  return {
    id: 'acc-1',
    displayName: 'Acme',
    enabled: true,
    usageUrl: 'https://example.com/usage',
    mappingMode: 'percent',
    percentPath: 'percent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

// Why: fetchCustomProviders() is fire-and-forget from fetchAll()/refresh() —
// awaiting a manual refresh() call (which explicitly awaits it) is the only
// externally-observable way to know the cycle has settled.
function serviceInternals(service: RateLimitService): {
  fetchCustomProviders: () => Promise<void>
} {
  return service as unknown as { fetchCustomProviders: () => Promise<void> }
}

describe('RateLimitService custom-provider usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchCustomProviderUsage).mockReset()
  })

  it('isolates a per-account token-resolution failure instead of rejecting the whole batch (#4)', async () => {
    const healthy = makeAccount({ id: 'acc-healthy' })
    const corrupt = makeAccount({ id: 'acc-corrupt' })
    const service = new RateLimitService()
    service.setCustomProviderConfigResolver(() => [healthy, corrupt])
    service.setCustomProviderTokenResolver((accountId) => {
      if (accountId === 'acc-corrupt') {
        throw new Error('keychain decrypt failed')
      }
      return 'token-value'
    })
    vi.mocked(fetchCustomProviderUsage).mockImplementation(async (account) => ({
      accountId: account.id,
      usedPercent: 42,
      resetsAt: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }))

    // Why: fetchCustomProviders() must not reject — a throwing resolver for
    // one account must not take down Promise.all for every account.
    await expect(serviceInternals(service).fetchCustomProviders()).resolves.toBeUndefined()

    const usage = service.getState().customProviderUsage
    expect(usage['acc-healthy']?.status).toBe('ok')
    expect(usage['acc-healthy']?.usedPercent).toBe(42)
    expect(usage['acc-corrupt']?.status).toBe('error')
    expect(usage['acc-corrupt']?.error).toContain('keychain decrypt failed')
  })

  it('fetches each enabled custom provider exactly once per manual refresh (#5)', async () => {
    const account = makeAccount()
    const service = new RateLimitService()
    service.setCustomProviderConfigResolver(() => [account])
    service.setCustomProviderTokenResolver(() => 'token-value')
    vi.mocked(fetchCustomProviderUsage).mockResolvedValue({
      accountId: account.id,
      usedPercent: 10,
      resetsAt: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })
    // Why: assert on the custom-provider cycle count directly, and on exactly
    // what refresh() passes to fetchAll, rather than driving the unrelated
    // fixed-provider fetchAll cycle (claude/codex/etc.) through to real
    // completion — that cycle needs its own unrelated mocking to not throw
    // and isn't what this regression is about. The regression: fetchAll's own
    // body also starts a fetchCustomProviders() cycle unless told not to, so
    // refresh() must pass skipCustomProviders: true or every manual refresh
    // double-fires an authenticated request per enabled custom provider.
    const fetchCustomProvidersSpy = vi.spyOn(
      service as unknown as { fetchCustomProviders: () => Promise<void> },
      'fetchCustomProviders'
    )
    const fetchAllSpy = vi
      .spyOn(service as unknown as { fetchAll: (options?: unknown) => Promise<void> }, 'fetchAll')
      .mockResolvedValue(undefined)

    await service.refresh()

    expect(fetchCustomProvidersSpy).toHaveBeenCalledTimes(1)
    expect(fetchCustomProviderUsage).toHaveBeenCalledTimes(1)
    expect(fetchAllSpy).toHaveBeenCalledWith(expect.objectContaining({ skipCustomProviders: true }))
  })

  it('does not preserve stale usage once the account becomes unavailable, e.g. after clearToken() (#11)', async () => {
    const account = makeAccount()
    const service = new RateLimitService()
    service.setCustomProviderConfigResolver(() => [account])
    service.setCustomProviderTokenResolver(() => 'token-value')

    vi.mocked(fetchCustomProviderUsage).mockResolvedValueOnce({
      accountId: account.id,
      usedPercent: 77,
      resetsAt: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })
    await serviceInternals(service).fetchCustomProviders()
    expect(service.getState().customProviderUsage[account.id]?.usedPercent).toBe(77)

    // Why: clearToken() is an intentional user action, not a transient
    // failure — 'unavailable' must replace the stale percent immediately.
    vi.mocked(fetchCustomProviderUsage).mockResolvedValueOnce({
      accountId: account.id,
      usedPercent: null,
      resetsAt: null,
      updatedAt: Date.now(),
      error: 'No token configured',
      status: 'unavailable',
      failureKind: 'missing-token'
    })
    await serviceInternals(service).fetchCustomProviders()

    const usage = service.getState().customProviderUsage[account.id]
    expect(usage?.status).toBe('unavailable')
    expect(usage?.usedPercent).toBeNull()
  })

  it('still preserves the last successful percent on a genuine fetch error', async () => {
    const account = makeAccount()
    const service = new RateLimitService()
    service.setCustomProviderConfigResolver(() => [account])
    service.setCustomProviderTokenResolver(() => 'token-value')

    vi.mocked(fetchCustomProviderUsage).mockResolvedValueOnce({
      accountId: account.id,
      usedPercent: 55,
      resetsAt: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })
    await serviceInternals(service).fetchCustomProviders()

    vi.mocked(fetchCustomProviderUsage).mockResolvedValueOnce({
      accountId: account.id,
      usedPercent: null,
      resetsAt: null,
      updatedAt: Date.now(),
      error: 'Request failed (HTTP 500)',
      status: 'error',
      failureKind: 'unknown'
    })
    await serviceInternals(service).fetchCustomProviders()

    const usage = service.getState().customProviderUsage[account.id]
    expect(usage?.status).toBe('error')
    expect(usage?.usedPercent).toBe(55)
  })
})
