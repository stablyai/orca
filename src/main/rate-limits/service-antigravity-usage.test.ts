import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  asRateLimitWindow,
  errorProvider,
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

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
  })

  it('publishes the Antigravity CLI reading, not the Gemini one', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    // Distinct values prove Antigravity is no longer a Gemini mirror.
    expect(state.antigravity?.session?.usedPercent).toBe(30)
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('keeps an Antigravity reading through a Gemini failure', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 55))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    // Separate credentials/endpoints mean Gemini auth failure cannot invalidate Antigravity (#9122).
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(55)
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('reports an Antigravity failure without touching Gemini', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'The Antigravity CLI did not report a quota.')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.session).toBeNull()
    expect(state.gemini?.status).toBe('ok')
  })

  it('surfaces a rejected Antigravity fetch as that provider\u2019s error', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockRejectedValue(new Error('spawn agy ENOENT'))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toContain('spawn agy ENOENT')
    expect(state.claude?.status).toBe('ok')
    expect(state.gemini?.status).toBe('ok')
  })
})

describe('Antigravity usage gating', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  })

  it('never spawns agy when the usage meter is hidden', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    service.setAntigravityUsageEnabledResolver(() => false)

    await service.refresh()

    // Hidden meters should not pay for agy language-server startup on every cycle.
    expect(fetchAntigravityRateLimits).not.toHaveBeenCalled()
    expect(service.getState().antigravity?.status).toBe('idle')
    expect(service.getState().gemini?.status).toBe('ok')
  })

  it('spawns agy when the meter is shown', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    service.setAntigravityUsageEnabledResolver(() => true)

    await service.refresh()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().antigravity?.status).toBe('ok')
  })

  it('keeps the last reading when the meter is hidden mid-session', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 44))
    const service = new RateLimitService()
    let enabled = true
    service.setAntigravityUsageEnabledResolver(() => enabled)
    await service.refresh()
    expect(service.getState().antigravity?.session?.usedPercent).toBe(44)

    enabled = false
    await service.refresh()

    // Hiding/revealing the meter must not flash away known usage.
    expect(service.getState().antigravity?.session?.usedPercent).toBe(44)
    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
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
