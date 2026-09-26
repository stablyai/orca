import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchDeepSeekRateLimits, isDeepSeekAuthConfigured } from './deepseek-fetcher'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { okProvider, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('./deepseek-fetcher', () => ({
  fetchDeepSeekRateLimits: vi.fn(),
  isDeepSeekAuthConfigured: vi.fn(() => false)
}))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))

describe('RateLimitService DeepSeek usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
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

    // Why: a thrown refresh is an error, and the stale policy keeps the last
    // balance on that error instead of dropping the row.
    expect(service.getState().deepseek).toMatchObject({
      status: 'error',
      error: 'balance down',
      monthly: { usedPercent: 15 }
    })
    expect(service.getState().claude?.status).toBe('ok')
  })
})
