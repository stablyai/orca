import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from '../providers/claude/claude-managed-account-usage'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import {
  deferred,
  flushMicrotasks,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))

vi.mock('../providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../deepseek-fetcher', () => ({
  fetchDeepSeekRateLimits: vi.fn(),
  isDeepSeekAuthConfigured: vi.fn(() => false)
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('../providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0, 1_000))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0, 1_000))
  })

  it('reads the account picked by a second switch made during a refresh', async () => {
    const service = new RateLimitService()
    const reads = [deferred<ProviderRateLimits>(), deferred<ProviderRateLimits>()]
    vi.mocked(fetchActiveClaudeRateLimits)
      .mockReturnValueOnce(reads[0].promise)
      .mockReturnValueOnce(reads[1].promise)
      .mockResolvedValueOnce(okProvider('claude', 55))
    void service.refresh()
    await flushMicrotasks(20)
    void service.refreshForClaudeAccountChange('acct-a')
    reads[0].resolve(okProvider('claude', 0))
    await flushMicrotasks(40)
    // The first switch's rerun is reading when the user switches again.
    void service.refreshForClaudeAccountChange('acct-b')
    reads[1].resolve(okProvider('claude', 11))
    await flushMicrotasks(60)
    expect(service.getState().claude?.session?.usedPercent).toBe(55)
  })

  it('keeps live Claude usage through refreshes without reading OAuth usage when disabled', async () => {
    mockFreshBackgroundProviderFetches()
    const service = new RateLimitService()
    service.setClaudeOAuthUsageEnabledResolver(() => false)
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'other' }])
    let home = '/claude/account-a'
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: home,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      provenance: home
    }))
    service.start({ fetchImmediately: false })
    await flushMicrotasks(20)
    service.stop()
    expect(service.getState().claude).toMatchObject({
      session: null,
      weekly: null,
      status: 'unavailable'
    })
    service.ingestLiveClaudeRateLimits({
      configDir: '/claude/account-a',
      fiveHour: { used_percentage: 33 },
      sevenDay: { used_percentage: 62 }
    })
    await service.refreshClaudeForTarget()
    await service.refresh()
    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(service.getState().claude).toMatchObject({
      session: { usedPercent: 33 },
      weekly: { usedPercent: 62 },
      status: 'ok',
      usageMetadata: { source: 'live-session' }
    })
    expect(service.getState().inactiveClaudeAccounts).toEqual([])
    expect(service.usageReadingAccount('claude')).toEqual({
      home: '/claude/account-a',
      provenance: '/claude/account-a'
    })
    expect(service.requestUsageReading('claude')).toBe(false)
    expect(fetchActiveClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchInactiveClaudeAccountUsage).not.toHaveBeenCalled()

    home = '/claude/account-b'
    await service.refreshForClaudeAccountChange('outgoing')
    expect(service.getState().claude?.session).toBeNull()
    expect(service.getState().claude?.status).toBe('unavailable')
    service.ingestLiveClaudeRateLimits({
      configDir: '/claude/account-b',
      fiveHour: { used_percentage: 12 },
      sevenDay: null
    })
    expect(service.getState().claude?.session?.usedPercent).toBe(12)
    expect(service.usageReadingAccount('claude')).toEqual({
      home: '/claude/account-b',
      provenance: '/claude/account-b'
    })
  })

  it('cancels pending Claude usage and rejects its reply even after polling is enabled again', async () => {
    mockFreshBackgroundProviderFetches()
    const service = new RateLimitService()
    let enabled = true
    service.setClaudeOAuthUsageEnabledResolver(() => enabled)
    const started = deferred<AbortSignal | undefined>()
    const reply = deferred<ProviderRateLimits>()
    vi.mocked(fetchActiveClaudeRateLimits).mockImplementationOnce((options) => {
      started.resolve(options?.signal)
      return reply.promise
    })
    const refresh = service.refresh()
    const signal = await started.promise

    enabled = false
    service.discardClaudeOAuthUsage()
    expect(signal?.aborted).toBe(true)
    service.ingestLiveClaudeRateLimits({
      configDir: null,
      fiveHour: { used_percentage: 41 },
      sevenDay: null
    })
    enabled = true
    reply.resolve(okProvider('claude', 90))
    await refresh

    expect(service.getState().claude).toMatchObject({
      session: { usedPercent: 41 },
      status: 'ok',
      usageMetadata: { source: 'live-session' }
    })
  })

  it('retains only terminal-observed windows when disabling OAuth-enriched usage', async () => {
    mockFreshBackgroundProviderFetches()
    const service = new RateLimitService()
    let enabled = true
    service.setClaudeOAuthUsageEnabledResolver(() => enabled)
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValueOnce({
      ...okProvider('claude', 20),
      weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      fableWeekly: {
        usedPercent: 70,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      extraUsage: {
        unit: 'credits',
        enabled: true,
        balance: 100,
        unlimited: false,
        disabledReason: null,
        resetsAt: null
      }
    })
    await service.refresh()
    service.ingestLiveClaudeRateLimits({
      configDir: null,
      fiveHour: { used_percentage: 35 },
      sevenDay: null
    })
    expect(service.getState().claude?.weekly?.usedPercent).toBe(50)

    enabled = false
    service.discardClaudeOAuthUsage()
    await service.refresh()

    expect(service.getState().claude).toMatchObject({
      session: { usedPercent: 35 },
      weekly: null,
      usageMetadata: { source: 'live-session' }
    })
    expect(service.getState().claude?.fableWeekly).toBeFalsy()
    expect(service.getState().claude?.extraUsage).toBeFalsy()
    await service.refreshForClaudeAccountChange('outgoing')
    expect(service.getState().claude?.session).toBeNull()
  })

  it('discards pending inactive-account usage when polling is disabled', async () => {
    const service = new RateLimitService()
    let enabled = true
    service.setClaudeOAuthUsageEnabledResolver(() => enabled)
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'other' }, { id: 'another' }])
    const started = deferred<AbortSignal | undefined>()
    const reply = deferred<ProviderRateLimits>()
    vi.mocked(fetchInactiveClaudeAccountUsage).mockImplementationOnce((_account, options) => {
      started.resolve(options?.signal)
      return reply.promise
    })
    const refresh = service.fetchInactiveClaudeAccountsOnOpen()
    const signal = await started.promise

    enabled = false
    service.discardClaudeOAuthUsage()
    expect(signal?.aborted).toBe(true)
    enabled = true
    reply.resolve(okProvider('claude', 90))
    await refresh

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
    expect(service.getState().claude).toMatchObject({
      session: null,
      weekly: null,
      status: 'unavailable'
    })
  })

  it.each(['all', 'claude'] as const)(
    'does not revive a canceled %s request still preparing account attribution',
    async (cycle) => {
      mockFreshBackgroundProviderFetches()
      const service = new RateLimitService()
      let enabled = true
      service.setClaudeOAuthUsageEnabledResolver(() => enabled)
      const oldAuth = { configDir: '/claude/old', envPatch: {}, provenance: 'old' }
      const preparation = deferred<typeof oldAuth>()
      service.setClaudeAuthPreparationResolver(
        vi
          .fn()
          .mockReturnValueOnce(preparation.promise)
          .mockResolvedValue({
            configDir: '/claude/current',
            envPatch: { CLAUDE_CONFIG_DIR: '/claude/current' },
            provenance: 'current'
          })
      )
      const refresh = cycle === 'all' ? service.refresh() : service.refreshClaudeForTarget()
      enabled = false
      service.discardClaudeOAuthUsage()
      enabled = true
      preparation.resolve(oldAuth)
      await refresh

      expect(fetchActiveClaudeRateLimits).not.toHaveBeenCalledWith(
        expect.objectContaining({ authPreparation: oldAuth })
      )
      service.ingestLiveClaudeRateLimits({
        configDir: '/claude/current',
        fiveHour: { used_percentage: 15 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(15)
      expect(service.usageReadingAccount('claude')).toEqual({
        home: '/claude/current',
        provenance: 'current'
      })
    }
  )
})
