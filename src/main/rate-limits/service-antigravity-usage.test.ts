import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import {
  asRateLimitWindow,
  errorProvider,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
} from './rate-limit-service-test-harness'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { LocalAccountRuntimeTarget } from '../../shared/local-account-runtime'

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

  it('drops stale usage when the default distro resolves to a different runtime', async () => {
    const withRuntime = (result: ProviderRateLimits, runtime: string): ProviderRateLimits => ({
      ...result,
      usageMetadata: { ...result.usageMetadata, authProvenance: runtime }
    })
    vi.mocked(fetchAntigravityRateLimits)
      .mockResolvedValueOnce(withRuntime(okProvider('antigravity', 30), 'wsl:ubuntu'))
      .mockResolvedValueOnce(withRuntime(errorProvider('antigravity', 'timed out'), 'wsl:debian'))
    const service = new RateLimitService()
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: null })

    await service.refresh()
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('error')
    expect(service.getState().antigravity?.session).toBeNull()
  })

  it('does not restore the outgoing snapshot after another provider awaits setup', async () => {
    const service = new RateLimitService()
    await service.refresh()
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    service.setCodexHomePathResolver(async () => {
      started.resolve()
      await pending.promise
      return { kind: 'ready', codexHomePath: null }
    })
    vi.mocked(fetchAntigravityRateLimits).mockRejectedValueOnce(new Error('WSL failed'))
    const refresh = service.refresh()
    await started.promise

    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    pending.resolve()
    await refresh

    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
    )
    expect(service.getState().antigravity?.session).toBeNull()
  })

  it.each([false, true])(
    'discards an outgoing read even after switching back: %s',
    async (switchBack) => {
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProviderRateLimits>()
      vi.mocked(fetchAntigravityRateLimits).mockImplementationOnce(() => {
        started.resolve()
        return pending.promise
      })
      const service = new RateLimitService()
      const refresh = service.refresh()
      await started.promise

      const target: LocalAccountRuntimeTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
      service.setAntigravityFetchTarget(target)
      if (switchBack) {
        service.setAntigravityFetchTarget({ runtime: 'host', wslDistro: null })
      }
      pending.resolve(okProvider('antigravity', 30))
      await refresh

      expect(service.getState().antigravity?.session).toBeNull()
    }
  )

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

  it('drops the old runtime cooldown before an automated refresh', async () => {
    vi.mocked(fetchAntigravityRateLimits)
      .mockResolvedValueOnce({
        ...unavailableProvider('antigravity', 'Sign in with agy'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60 * 1000 }
      })
      .mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    await service.refresh()

    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await service.refreshIfStale()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().antigravity?.session?.usedPercent).toBe(30)
  })

  it('waits out the browser sign-in cooldown, then recovers on the next poll', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
      vi.mocked(fetchAntigravityRateLimits)
        .mockImplementationOnce(async () => ({
          ...unavailableProvider('antigravity', 'Sign in with `agy`'),
          usageMetadata: {
            failureKind: 'missing-credentials',
            retryAtMs: Date.now() + 60 * 60 * 1000
          }
        }))
        .mockImplementation(async () => okProvider('antigravity', 30))
      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      // Why: each read inside the cooldown would open another browser sign-in page (#26484).
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(58 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(32 * 60 * 1000)
      expect(vi.mocked(fetchAntigravityRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(service.getState().antigravity?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
