import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import {
  asRateLimitWindow,
  deferred,
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

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('removes all window listeners when replacing the attached window', () => {
    const service = new RateLimitService()
    const firstWindow = new FakeRateLimitWindow()
    const secondWindow = new FakeRateLimitWindow()

    service.attach(asRateLimitWindow(firstWindow))
    expect(firstWindow.listenerCount('focus')).toBe(1)
    expect(firstWindow.listenerCount('show')).toBe(1)
    expect(firstWindow.listenerCount('restore')).toBe(1)
    expect(firstWindow.listenerCount('closed')).toBe(1)

    service.attach(asRateLimitWindow(secondWindow))

    expect(firstWindow.listenerCount('focus')).toBe(0)
    expect(firstWindow.listenerCount('show')).toBe(0)
    expect(firstWindow.listenerCount('restore')).toBe(0)
    expect(firstWindow.listenerCount('closed')).toBe(0)
    expect(secondWindow.listenerCount('focus')).toBe(1)
    expect(secondWindow.listenerCount('show')).toBe(1)
    expect(secondWindow.listenerCount('restore')).toBe(1)
    expect(secondWindow.listenerCount('closed')).toBe(1)

    service.stop()

    expect(secondWindow.listenerCount('focus')).toBe(0)
    expect(secondWindow.listenerCount('show')).toBe(0)
    expect(secondWindow.listenerCount('restore')).toBe(0)
    expect(secondWindow.listenerCount('closed')).toBe(0)
  })

  it('sanitizes renderer-provided polling intervals before scheduling timers', () => {
    vi.useFakeTimers()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))
      const service = new RateLimitService()

      service.setPollingInterval(Number.NaN)
      service.start()
      expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 15 * 60 * 1000)

      service.setPollingInterval(Number.MAX_SAFE_INTEGER)
      expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647)

      service.setPollingInterval(10)
      expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000)

      service.stop()
    } finally {
      intervalSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fetches usage on the first active window event after deferred startup', async () => {
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))
    const service = new RateLimitService()
    const window = new FakeRateLimitWindow()

    service.attach(asRateLimitWindow(window))
    service.start({ fetchImmediately: false })
    await Promise.resolve()

    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()

    window.emit('focus')
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

    service.stop()
  })

  it('performs a one-shot active-window fetch when startup focus was missed', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))
      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()

      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
      expect(fetchCodexRateLimits).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers a failed deferred-startup Claude fetch on the next focus', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockResolvedValueOnce(errorProvider('claude', 'auth restarting'))
        .mockResolvedValueOnce(okProvider('claude', 12))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(service.getState().claude?.status).toBe('error')
      expect(service.getState().codex?.status).toBe('ok')

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchMiniMaxRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchGrokRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().claude?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off repeated active-window retries while Claude is still failing', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(errorProvider('claude', 'still failing'))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // First activation recovers immediately (retry timestamps start at 0).
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Two consecutive failures: the retry window doubled to 60s, so an
      // activation at +30s must not hammer the endpoint again.
      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('restore')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // Three consecutive failures: 120s window.
      await vi.advanceTimersByTimeAsync(60 * 1000)
      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(60 * 1000)
      window.emit('restore')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the retry backoff once Claude recovers', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockResolvedValueOnce(errorProvider('claude', 'still failing'))
        .mockResolvedValueOnce(errorProvider('claude', 'still failing'))
        .mockResolvedValueOnce(okProvider('claude', 12))
        .mockResolvedValue(errorProvider('claude', 'failing again'))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Recovery fetch succeeds and must clear the failure streak.
      await vi.advanceTimersByTimeAsync(60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().claude?.status).toBe('ok')

      // The stale-ok snapshot forces a full refresh, which fails again.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      expect(service.getState().claude?.status).toBe('error')

      // Consume the stale active-retry timestamp so the next windows measure
      // the post-recovery streak rather than time elapsed before recovery.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)

      // Post-recovery streak is 2 (not the pre-recovery 4): the window must be
      // 60s, so +30s stays throttled and +60s retries.
      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)

      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(6)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a stale-driven full fetch as the failing provider retry attempt', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () =>
        errorProvider('claude', 'still failing')
      )
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Healthy providers go stale after 5 minutes, so this activation runs a
      // full fetch that also retries failing Claude (streak now 3 → 120s).
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // Why: the full fetch was itself a retry. An activation moments later
      // must not fire the individual failure lane ahead of the backoff window.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // Once the 120s window elapses, the individual retry lane fires again.
      await vi.advanceTimersByTimeAsync(120 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out Retry-After before automated Claude refetches, then recovers', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 40 * 60 * 1000 }
        }))
        .mockImplementation(async () => okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // Activations that would normally retry immediately must respect the server's Retry-After.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // The 15- and 30-minute poll cycles land inside the 40-minute window: other providers refresh, Claude is skipped.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // The 45-minute poll cycle is past the window and refetches Claude.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a user-directed refresh bypass the Claude Retry-After gate', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 40 * 60 * 1000 }
        }))
        .mockImplementation(async () => okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()

      await service.refresh()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().claude?.status).toBe('error')

      await service.refresh()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps last-known usage through a rate-limited window past the generic stale threshold', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 18))
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited' }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()

      await service.refresh()
      expect(service.getState().claude?.status).toBe('ok')

      // 31 minutes later the generic 30-minute stale policy would drop the snapshot; rate-limited failures keep it.
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
      await service.refresh()

      const claude = service.getState().claude
      expect(claude?.status).toBe('error')
      expect(claude?.error).toBe('Claude usage is rate limited right now.')
      expect(claude?.session?.usedPercent).toBe(18)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a settled error chip settled during background refetches instead of flashing fetching', async () => {
    vi.useFakeTimers()
    try {
      const secondClaude = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockResolvedValueOnce(errorProvider('claude', 'still failing'))
        .mockImplementationOnce(() => secondClaude.promise)
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      const claudeStatuses: string[] = []
      service.onStateChange((state) => {
        if (state.claude) {
          claudeStatuses.push(state.claude.status)
        }
      })
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(service.getState().claude?.status).toBe('error')

      // Why: the retry must not repaint the settled error chip as a loading
      // "…" chip while the refetch is in flight — that is the flash users see
      // every cycle when a provider is stuck failing.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(service.getState().claude?.status).toBe('error')

      secondClaude.resolve(okProvider('claude', 12))
      await vi.advanceTimersByTimeAsync(0)
      expect(service.getState().claude?.status).toBe('ok')

      const statusesAfterFirstSettle = claudeStatuses.slice(claudeStatuses.indexOf('error'))
      expect(statusesAfterFirstSettle).not.toContain('fetching')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a full-fetch retry on the 5-minute cadence for a provider without a dedicated fetch cycle', async () => {
    vi.useFakeTimers()
    try {
      // Kimi has no individual fetch cycle, so recovering it re-runs fetchAll
      // (which hits Claude's tight-budget endpoint). A durable Kimi error must
      // not drive that full fetch every 30s — it stays on the 5-minute cadence.
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))
      vi.mocked(fetchKimiRateLimits).mockResolvedValue(errorProvider('kimi', 'token expired'))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().kimi?.status).toBe('error')

      // First activation recovers immediately (retry timestamps start at 0).
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Well past the 30s failure throttle but inside the 5-minute window: the
      // full fetch (and the Claude read it entails) must not fire again.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // After the full 5-minute window the retry fires again.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      window.emit('restore')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(3)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces unavailable providers on active window events', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(unavailableProvider('claude'))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(unavailableProvider('codex'))
      vi.mocked(fetchGeminiRateLimits).mockResolvedValue(unavailableProvider('gemini'))
      vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(unavailableProvider('opencode-go'))
      vi.mocked(fetchKimiRateLimits).mockResolvedValue(unavailableProvider('kimi'))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(2)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still debounces a focus event within the window after a successful fetch', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 24))

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // A focus within MIN_REFETCH_MS after a GOOD fetch must still no-op.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
