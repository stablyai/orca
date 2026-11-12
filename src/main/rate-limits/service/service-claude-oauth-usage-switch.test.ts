import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from '../providers/claude/claude-managed-account-usage'
import {
  deferred,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => undefined
}))

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

const LIVE_POST = { configDir: null, fiveHour: { used_percentage: 33 }, sevenDay: null }

function serviceWithOAuthUsage(enabled: boolean): RateLimitService {
  const service = new RateLimitService()
  service.setClaudeOAuthUsageEnabledResolver(() => enabled)
  return service
}

describe('Claude OAuth usage switch', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
    vi.mocked(fetchInactiveClaudeAccountUsage).mockResolvedValue(okProvider('claude', 18))
    mockFreshBackgroundProviderFetches()
  })

  it('makes no usage request from a full, manual or account-change cycle', async () => {
    const service = serviceWithOAuthUsage(false)

    await service.refresh()
    await service.refreshClaudeForTarget()
    await service.refreshForClaudeAccountChange('account')

    expect(fetchActiveClaudeRateLimits).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('unavailable')
  })

  it('skips inactive account previews', async () => {
    const service = serviceWithOAuthUsage(false)
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'other' }])

    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchInactiveClaudeAccountUsage).not.toHaveBeenCalled()
  })

  it.each(['full', 'claude-only'])(
    'still accepts statusLine usage after a %s cycle',
    async (cycle) => {
      const service = serviceWithOAuthUsage(false)

      await (cycle === 'full' ? service.refresh() : service.refreshClaudeForTarget())
      service.ingestLiveClaudeRateLimits(LIVE_POST)

      expect(service.getState().claude?.session?.usedPercent).toBe(33)
    }
  )

  it('keeps statusLine numbers through later cycles', async () => {
    const service = serviceWithOAuthUsage(false)
    await service.refresh()
    service.ingestLiveClaudeRateLimits(LIVE_POST)

    await service.refresh()

    expect(service.getState().claude?.status).toBe('ok')
    expect(service.getState().claude?.session?.usedPercent).toBe(33)
  })

  it.each(['refresh', 'refreshClaudeForTarget'] as const)(
    'discards earlier OAuth usage on %s after opting out',
    async (refresh) => {
      let enabled = true
      const service = new RateLimitService()
      service.setClaudeOAuthUsageEnabledResolver(() => enabled)
      await service.refresh()
      enabled = false

      await service[refresh]()

      expect(service.getState().claude).toMatchObject({ status: 'unavailable', session: null })
    }
  )

  it.each(['refresh', 'refreshClaudeForTarget'] as const)(
    'discards an OAuth result completing after opt-out during %s',
    async (refresh) => {
      let enabled = true
      const service = new RateLimitService()
      service.setClaudeOAuthUsageEnabledResolver(() => enabled)
      const started = deferred<void>()
      const pending = deferred<Awaited<ReturnType<typeof fetchActiveClaudeRateLimits>>>()
      vi.mocked(fetchActiveClaudeRateLimits).mockImplementationOnce(() => {
        started.resolve()
        return pending.promise
      })
      const cycle = service[refresh]()
      await started.promise
      enabled = false
      pending.resolve(okProvider('claude', 81))
      await cycle

      expect(service.getState().claude).toMatchObject({ status: 'unavailable', session: null })
    }
  )

  it('keeps live usage when an older OAuth request completes after opt-out', async () => {
    let enabled = true
    const service = new RateLimitService()
    service.setClaudeOAuthUsageEnabledResolver(() => enabled)
    const started = deferred<void>()
    const pending = deferred<Awaited<ReturnType<typeof fetchActiveClaudeRateLimits>>>()
    vi.mocked(fetchActiveClaudeRateLimits).mockImplementationOnce(() => {
      started.resolve()
      return pending.promise
    })
    const cycle = service.refresh()
    await started.promise
    enabled = false
    service.ingestLiveClaudeRateLimits(LIVE_POST)
    pending.resolve(okProvider('claude', 81))
    await cycle

    expect(service.getState().claude).toMatchObject({
      status: 'ok',
      session: { usedPercent: 33 },
      usageMetadata: { source: 'live-session' }
    })
  })

  it('fetches when the user turns it on', async () => {
    await serviceWithOAuthUsage(true).refresh()

    expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(1)
  })

  describe('opting out', () => {
    let enabled: boolean
    let service: RateLimitService

    function optOut(): void {
      enabled = false
      service.discardClaudeOAuthUsage()
    }

    beforeEach(() => {
      enabled = true
      service = new RateLimitService()
      service.setClaudeOAuthUsageEnabledResolver(() => enabled)
    })

    it.each(['nothing else', 'a refresh', 'a duplicate statusLine post', 'a new statusLine post'])(
      'leaves no OAuth window, Fable or credit figure after %s',
      async (next) => {
        vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValueOnce({
          ...okProvider('claude', 18),
          weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: null, resetDescription: null },
          fableWeekly: okProvider('claude', 40).session,
          extraUsage: {
            unit: 'credits',
            balance: 5,
            unlimited: false,
            enabled: true,
            disabledReason: null,
            resetsAt: null
          }
        })
        await service.refresh()
        // A five-hour-only post inherits the OAuth weekly window and relabels it live-session.
        service.ingestLiveClaudeRateLimits(LIVE_POST)
        optOut()

        if (next === 'a refresh') {
          await service.refresh()
        } else if (next === 'a duplicate statusLine post') {
          service.ingestLiveClaudeRateLimits(LIVE_POST)
        } else if (next === 'a new statusLine post') {
          service.ingestLiveClaudeRateLimits({ ...LIVE_POST, fiveHour: { used_percentage: 34 } })
        }

        const claude = service.getState().claude
        expect(claude?.weekly ?? null).toBeNull()
        expect(claude?.fableWeekly ?? null).toBeNull()
        expect(claude?.extraUsage ?? null).toBeNull()
      }
    )

    it('drops inactive account previews, including one still in flight', async () => {
      service.setInactiveClaudeAccountsResolver(() => [{ id: 'cached' }, { id: 'pending' }])
      const started = deferred<void>()
      const pending = deferred<Awaited<ReturnType<typeof fetchInactiveClaudeAccountUsage>>>()
      vi.mocked(fetchInactiveClaudeAccountUsage)
        .mockResolvedValueOnce(okProvider('claude', 10))
        .mockImplementationOnce(() => {
          started.resolve()
          return pending.promise
        })
      const previews = service.fetchInactiveClaudeAccountsOnOpen()
      await started.promise
      optOut()
      pending.resolve(okProvider('claude', 20))
      await previews

      expect(service.getState().inactiveClaudeAccounts).toEqual([])
    })
  })
})
