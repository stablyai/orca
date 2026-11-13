import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from '../providers/claude/claude-managed-account-usage'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { okProvider, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

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

describe('RateLimitService with the Claude usage meter hidden', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends no Claude requests from any refresh entry point and settles to idle', async () => {
    const service = new RateLimitService()
    const authPreparation = vi.fn(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      provenance: 'system'
    }))
    service.setClaudeAuthPreparationResolver(authPreparation)
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'account-1' }])
    service.setClaudeUsageEnabledResolver(() => false)

    await service.refresh()
    await service.refreshClaudeForTarget()
    await service.refreshForClaudeAccountChange('account-1')
    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchActiveClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchInactiveClaudeAccountUsage).not.toHaveBeenCalled()
    expect(authPreparation).not.toHaveBeenCalled()
    expect(service.requestUsageReading('claude')).toBe(false)
    expect(service.getState().claude).toMatchObject({ status: 'idle', session: null })
  })

  it('reads Claude again once the meter is shown', async () => {
    const service = new RateLimitService()
    let enabled = false
    service.setClaudeUsageEnabledResolver(() => enabled)

    await service.refresh()
    enabled = true
    await service.refresh()

    expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().claude).toMatchObject({
      status: 'ok',
      session: { usedPercent: 7 }
    })
  })
})
