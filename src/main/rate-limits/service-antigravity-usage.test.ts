import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  asRateLimitWindow,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
} from './rate-limit-service-test-harness'

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

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

describe('Antigravity usage gating', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  })

  it('holds browser sign-in reads until a credential change or refresh', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
      const signInRequired = async () => ({
        ...unavailableProvider('antigravity', 'Sign in with `agy`'),
        usageMetadata: {
          failureKind: 'missing-credentials' as const,
          retryAtMs: Number.MAX_SAFE_INTEGER
        }
      })
      vi.mocked(fetchAntigravityRateLimits)
        .mockImplementationOnce(signInRequired)
        .mockImplementationOnce(signInRequired)
        .mockImplementation(async () => okProvider('antigravity', 30))
      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      // Why: each automated read would open another browser sign-in page (#26484).
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      service.invalidateAntigravityCredentialState()
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)

      await service.refresh()
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().antigravity?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['held', 'sign-in', 'usage'] as const)(
    'preserves a credential change during the %s background cycle',
    async (phase) => {
      vi.useFakeTimers()
      const service = new RateLimitService()
      try {
        mockFreshBackgroundProviderFetches()
        const signInRequired: ProviderRateLimits = {
          ...unavailableProvider('antigravity'),
          usageMetadata: {
            failureKind: 'missing-credentials',
            retryAtMs: Number.MAX_SAFE_INTEGER
          }
        }
        vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(signInRequired)
        if (phase === 'held') {
          await service.refresh()
        }
        const pending = Promise.withResolvers<ProviderRateLimits>()
        if (phase === 'held') {
          vi.mocked(fetchClaudeRateLimits).mockReturnValueOnce(pending.promise)
        } else {
          vi.mocked(fetchAntigravityRateLimits).mockReturnValueOnce(pending.promise)
        }
        service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
        service.start()
        await vi.advanceTimersByTimeAsync(0)
        expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
        expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(phase === 'held' ? 2 : 1)

        service.invalidateAntigravityCredentialState()
        pending.resolve(
          phase === 'held'
            ? okProvider('claude', 7)
            : phase === 'usage'
              ? okProvider('antigravity', 30)
              : signInRequired
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(service.getState().antigravity).toBeNull()

        vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 60))
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
        expect(service.getState().antigravity?.session?.usedPercent).toBe(60)
      } finally {
        service.stop()
        vi.useRealTimers()
      }
    }
  )

  it('uses the released hold when credentials change during asynchronous cycle preparation', async () => {
    vi.useFakeTimers()
    const service = new RateLimitService()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
        ...unavailableProvider('antigravity'),
        usageMetadata: { retryAtMs: Number.MAX_SAFE_INTEGER }
      })
      await service.refresh()
      service.setCodexHomePathResolver(
        vi
          .fn()
          .mockResolvedValue(null)
          .mockImplementationOnce(async () => {
            service.invalidateAntigravityCredentialState()
            return null
          })
      )
      vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 60))

      service.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().antigravity?.session?.usedPercent).toBe(60)
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })
})
