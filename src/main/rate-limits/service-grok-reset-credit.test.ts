import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { consumeGrokRateLimitResetCredit } from './grok-reset-credit-consumer'
import { fetchGrokRateLimits } from './grok-fetcher'
import { resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

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
vi.mock('./opencode-go-usage-fetcher', () => ({ fetchOpenCodeGoRateLimits: vi.fn() }))
vi.mock('./minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-reset-credit-consumer', () => ({ consumeGrokRateLimitResetCredit: vi.fn() }))
vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

function grokLimits(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: {
      usedPercent,
      windowMinutes: 10_080,
      resetsAt: null,
      resetDescription: null
    },
    rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('RateLimitService Grok reset redemption', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('refuses to spend a token when weekly usage is already 0%', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(0))
    const service = new RateLimitService()
    await service.refreshGrok()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'nothingToReset'
    })
    expect(consumeGrokRateLimitResetCredit).not.toHaveBeenCalled()
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(2)
  })

  it('force-fetches before deciding when no Grok snapshot exists yet', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(0))
    vi.mocked(consumeGrokRateLimitResetCredit).mockResolvedValueOnce('reset')
    const service = new RateLimitService()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce()
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(2)
  })

  it('refuses redemption when the fresh snapshot has no weekly window', async () => {
    vi.mocked(fetchGrokRateLimits).mockResolvedValueOnce({
      ...grokLimits(80),
      weekly: null,
      monthly: grokLimits(80).weekly
    })
    const service = new RateLimitService()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'nothingToReset'
    })
    expect(consumeGrokRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('keeps redemption retryable when a failed fetch retains stale nonzero usage', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce({
        ...grokLimits(80),
        weekly: null,
        status: 'error',
        error: 'provider failed'
      })
    const service = new RateLimitService()
    await service.refreshGrok()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'usageUnavailable',
      state: { grok: { status: 'error', weekly: { usedPercent: 80 } } }
    })
    expect(consumeGrokRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('updates state after a successful redemption', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(0))
    vi.mocked(consumeGrokRateLimitResetCredit).mockResolvedValueOnce('reset')
    const service = new RateLimitService()
    await service.refreshGrok()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'reset',
      state: { grok: { weekly: { usedPercent: 0 } } }
    })
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(3)
  })

  it('force-refreshes after an expired token maps to noCredit', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(80))
    vi.mocked(consumeGrokRateLimitResetCredit).mockResolvedValueOnce('noCredit')
    const service = new RateLimitService()

    await expect(service.consumeGrokRateLimitResetCredit()).resolves.toMatchObject({
      outcome: 'noCredit'
    })
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(2)
  })

  it('forces a refetch when redemption fails', async () => {
    vi.mocked(fetchGrokRateLimits)
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(80))
      .mockResolvedValueOnce(grokLimits(65))
    vi.mocked(consumeGrokRateLimitResetCredit).mockRejectedValueOnce(new Error('provider failed'))
    const service = new RateLimitService()
    await service.refreshGrok()

    await expect(service.consumeGrokRateLimitResetCredit()).rejects.toThrow('provider failed')
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(3)
    expect(service.getState().grok?.weekly?.usedPercent).toBe(65)
  })
})
