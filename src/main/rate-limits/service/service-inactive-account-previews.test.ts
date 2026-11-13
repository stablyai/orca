import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from '../providers/claude/claude-managed-account-usage'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import {
  deferred,
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

vi.mock('../providers/kiro/kiro-fetcher', () => ({
  fetchKiroRateLimits: vi.fn()
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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0, 1_000))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0, 1_000))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not overwrite inactive Claude cache from a stale same-id fetch', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'account-1' }])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      provenance: 'system'
    }))
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchInactiveClaudeAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()

    await service.refreshForClaudeAccountChange('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([
      {
        accountId: 'account-1',
        rateLimits: expect.objectContaining({
          provider: 'claude',
          session: expect.objectContaining({ usedPercent: 7 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })
})
