import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchDeepSeekRateLimits, isDeepSeekAuthConfigured } from '../deepseek-fetcher'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
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

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
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
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService DeepSeek usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
    vi.mocked(isDeepSeekAuthConfigured).mockReturnValue(false)
  })

  it('stays unconfigured and does not publish a balance when the env key is absent', async () => {
    const service = new RateLimitService()
    await service.refresh()

    expect(service.getState().deepseekAuthConfigured).toBe(false)
    expect(fetchDeepSeekRateLimits).toHaveBeenCalledWith(expect.objectContaining({}))
    expect(service.getState().deepseek?.status).toBe('unavailable')
  })

  it('publishes the balance snapshot and keeps a sibling failure off the DeepSeek row', async () => {
    vi.mocked(isDeepSeekAuthConfigured).mockReturnValue(true)
    vi.mocked(fetchDeepSeekRateLimits).mockResolvedValue({
      ...okProvider('deepseek', 0),
      session: null,
      monthly: {
        usedPercent: 20,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: 'USD'
      }
    })

    const service = new RateLimitService()
    await service.refresh()

    expect(service.getState().deepseekAuthConfigured).toBe(true)
    expect(service.getState().deepseek).toMatchObject({
      provider: 'deepseek',
      status: 'ok',
      monthly: { usedPercent: 20 }
    })
    expect(service.getState().gemini?.status).toBe('ok')
  })

  it('keeps the last balance when a later refresh throws', async () => {
    vi.mocked(isDeepSeekAuthConfigured).mockReturnValue(true)
    vi.mocked(fetchDeepSeekRateLimits).mockResolvedValueOnce({
      ...okProvider('deepseek', 0),
      session: null,
      monthly: {
        usedPercent: 15,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: 'USD'
      }
    })
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchDeepSeekRateLimits).mockRejectedValueOnce(new Error('balance down'))
    await service.refresh()

    // A thrown refresh is an error, and the stale policy keeps the last balance.
    expect(service.getState().deepseek).toMatchObject({
      status: 'error',
      error: 'balance down',
      monthly: { usedPercent: 15 }
    })
    expect(service.getState().claude?.status).toBe('ok')
  })
})
