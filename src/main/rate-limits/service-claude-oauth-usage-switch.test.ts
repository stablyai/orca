import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import {
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => undefined
}))

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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
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
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 18))
    mockFreshBackgroundProviderFetches()
  })

  it('makes no usage request from a full, manual or account-change cycle', async () => {
    const service = serviceWithOAuthUsage(false)

    await service.refresh()
    await service.refreshClaudeForTarget()
    await service.refreshForClaudeAccountChange('account')

    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('unavailable')
  })

  it('skips inactive account previews', async () => {
    const service = serviceWithOAuthUsage(false)
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'other' }])

    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
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

  it('fetches when the user turns it on', async () => {
    await serviceWithOAuthUsage(true).refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })
})
