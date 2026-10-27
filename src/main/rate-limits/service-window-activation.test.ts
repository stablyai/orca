import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax/minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
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
    for (let tick = 0; tick < 3; tick += 1) {
      await Promise.resolve()
    }

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
      expect(fetchOpenCodeGoUsage).toHaveBeenCalledTimes(1)
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

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Second failure doubles the retry gate to 60s; +30s must remain throttled.
      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('restore')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

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

      await vi.advanceTimersByTimeAsync(60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().claude?.status).toBe('ok')

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      expect(service.getState().claude?.status).toBe('error')

      // Consume the prior activation timestamp so subsequent delays measure the post-recovery streak.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)

      // Recovery reset the streak: the second new failure gates 60s, not the pre-recovery 4-failure duration.
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

      // Stale healthy siblings force a full fetch, advancing Claude's failure backoff too.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // Full fetch already retried Claude; activation cannot bypass its new backoff.
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

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

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // Poll cycles inside Retry-After may refresh siblings, never Claude.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

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

      // Rate-limited display survives beyond the generic stale cutoff.
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

  it('keeps last-known usage through an expired access token past the generic stale threshold', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 18))
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token' }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()

      await service.refresh()
      expect(service.getState().claude?.status).toBe('ok')

      // Why: Orca never refreshes a Claude login, so an idle account's usage 401s until Claude runs again.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      await service.refresh()

      const claude = service.getState().claude
      expect(claude?.status).toBe('error')
      expect(claude?.usageMetadata?.failureKind).toBe('stale-token')
      expect(claude?.session?.usedPercent).toBe(18)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a non-Claude expired sign-in age out at the generic stale threshold', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => okProvider('claude', 18))
      vi.mocked(fetchCursorRateLimits)
        .mockImplementationOnce(async () => okProvider('cursor', 42))
        .mockImplementation(async () => ({
          ...errorProvider('cursor', 'Cursor sign-in expired — run `cursor-agent login` again'),
          usageMetadata: { failureKind: 'stale-token' }
        }))

      const service = new RateLimitService()
      await service.refresh()
      expect(service.getState().cursor?.session?.usedPercent).toBe(42)

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      await service.refresh()

      const cursor = service.getState().cursor
      expect(cursor?.status).toBe('error')
      expect(cursor?.usageMetadata?.failureKind).toBe('stale-token')
      expect(cursor?.session).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a kept window once its reset passes and keeps the rest', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...okProvider('claude', 18),
          session: {
            usedPercent: 18,
            windowMinutes: 300,
            resetsAt: startedAt + 60 * 60 * 1000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 40,
            windowMinutes: 10080,
            resetsAt: startedAt + 3 * 24 * 60 * 60 * 1000,
            resetDescription: null
          }
        }))
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token' }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      await service.refresh()

      const claude = service.getState().claude
      expect(claude?.status).toBe('error')
      expect(claude?.session).toBeNull()
      expect(claude?.weekly?.usedPercent).toBe(40)
      expect(claude?.updatedAt).toBe(startedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an outgoing account whose kept snapshot lost only its reset 5h window', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...okProvider('claude', 18),
          session: {
            usedPercent: 18,
            windowMinutes: 300,
            resetsAt: startedAt + 60 * 60 * 1000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 40,
            windowMinutes: 10080,
            resetsAt: startedAt + 3 * 24 * 60 * 60 * 1000,
            resetDescription: null
          }
        }))
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token' }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      service.setInactiveClaudeAccountsResolver(() => [{ id: 'outgoing' }])
      await service.refresh()
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      await service.refresh()
      await service.refreshForClaudeAccountChange('outgoing')

      const outgoing = service
        .getState()
        .inactiveClaudeAccounts.find((row) => row.accountId === 'outgoing')
      expect(outgoing?.rateLimits?.session).toBeNull()
      expect(outgoing?.rateLimits?.weekly?.usedPercent).toBe(40)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the failure instead of a kept snapshot once every window has reset', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...okProvider('claude', 18),
          session: {
            usedPercent: 18,
            windowMinutes: 300,
            resetsAt: Date.now() + 60 * 60 * 1000,
            resetDescription: null
          }
        }))
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token' }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      const failedAt = Date.now()
      await service.refresh()

      const claude = service.getState().claude
      expect(claude?.status).toBe('error')
      expect(claude?.session).toBeNull()
      expect(claude?.weekly).toBeNull()
      expect(claude?.updatedAt).toBe(failedAt)
      expect(claude?.error).toBe('Claude usage updates the next time Claude runs.')
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

      // Keep settled error chips visible during retry to avoid loading/error flashes.
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
      // Kimi recovery forces a full fetch including tight-budget Claude; retain five-minute cadence instead of 30s retries.
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

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Failure-throttle expiry alone must not trigger another Kimi full cycle.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

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
      vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(unavailableProvider('opencode-go'))
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
      expect(fetchOpenCodeGoUsage).toHaveBeenCalledTimes(1)
      expect(fetchKimiRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      window.emit('show')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchOpenCodeGoUsage).toHaveBeenCalledTimes(2)
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

      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
