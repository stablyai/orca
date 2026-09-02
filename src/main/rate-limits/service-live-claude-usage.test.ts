import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  asRateLimitWindow,
  deferred,
  errorProvider,
  FakeRateLimitWindow,
  flushMicrotasks,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
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

  it('ingests statusline usage, clears errors, and skips OAuth polls while the live feed is fresh', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => ({
        ...errorProvider('claude', 'Claude usage is rate limited right now.'),
        usageMetadata: { failureKind: 'rate-limited' }
      }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().claude?.status).toBe('error')

      // A live session reports usage 12 minutes in; the error state clears without any OAuth call.
      await vi.advanceTimersByTimeAsync(12 * 60 * 1000 - 1000)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 23.5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        sevenDay: { used_percentage: 41.2 }
      })

      const claude = service.getState().claude
      expect(claude?.status).toBe('ok')
      expect(claude?.error).toBeNull()
      expect(claude?.session?.usedPercent).toBe(23.5)
      expect(claude?.weekly?.usedPercent).toBe(41.2)
      expect(claude?.usageMetadata?.source).toBe('live-session')

      // The 15-minute poll cycle lands inside the live-feed freshness window: other providers refresh, Claude's OAuth fetch is skipped.
      const codexCallsBeforePoll = vi.mocked(fetchCodexRateLimits).mock.calls.length
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(
        codexCallsBeforePoll
      )
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // Once the live feed goes stale, automated refetches resume.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(vi.mocked(fetchClaudeRateLimits).mock.calls.length).toBeGreaterThan(1)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops statusline posts before attribution is known or from a mismatched config dir', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()

      // No fetch cycle has captured the selected account's config dir yet.
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 50 },
        sevenDay: null
      })
      expect(service.getState().claude).toBeNull()

      await service.refresh()
      expect(service.getState().claude?.session?.usedPercent).toBe(18)

      // A managed-account session must not overwrite the system-default bar.
      service.ingestLiveClaudeRateLimits({
        configDir: '/some/managed/dir',
        fiveHour: { used_percentage: 99 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(18)

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 33 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(33)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the other window when a statusline post carries only one', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 20 },
        sevenDay: { used_percentage: 41 }
      })
      expect(service.getState().claude?.weekly?.usedPercent).toBe(41)

      // A later post reporting only the 5h window must not wipe the weekly bar.
      await vi.advanceTimersByTimeAsync(1000)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 25 },
        sevenDay: null
      })
      const claude = service.getState().claude
      expect(claude?.session?.usedPercent).toBe(25)
      expect(claude?.weekly?.usedPercent).toBe(41)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dedupes identical statusline posts within the throttle window', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()

      const event = {
        configDir: null,
        fiveHour: { used_percentage: 20, resets_at: 1738425600 },
        sevenDay: null
      }
      service.ingestLiveClaudeRateLimits(event)
      const firstUpdatedAt = service.getState().claude?.updatedAt

      await vi.advanceTimersByTimeAsync(1000)
      service.ingestLiveClaudeRateLimits(event)
      expect(service.getState().claude?.updatedAt).toBe(firstUpdatedAt)

      // A changed window updates immediately despite the throttle.
      service.ingestLiveClaudeRateLimits({
        ...event,
        fiveHour: { used_percentage: 21, resets_at: 1738425600 }
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(21)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not roll back a live-session snapshot that arrived while a claude fetch was in flight', async () => {
    vi.useFakeTimers()
    try {
      const parkedClaudeFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 18))
        .mockImplementationOnce(() => parkedClaudeFetch.promise)
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()

      const secondRefresh = service.refresh()
      await flushMicrotasks()

      // A live statusline post lands while the second fetch is parked in flight.
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(41)

      parkedClaudeFetch.resolve({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'boom',
        status: 'error'
      })
      await secondRefresh

      // The failed fetch must not roll the bar back to the pre-cycle snapshot or flip it to error.
      const claude = service.getState().claude
      expect(claude?.status).toBe('ok')
      expect(claude?.session?.usedPercent).toBe(41)
      expect(claude?.usageMetadata?.source).toBe('live-session')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a populated weekly bar when a live post carries only the five-hour window', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue({
        ...okProvider('claude', 18),
        weekly: { usedPercent: 62, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      })
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      await service.refresh()
      expect(service.getState().claude?.weekly?.usedPercent).toBe(62)

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 23.5 },
        sevenDay: null
      })

      const claude = service.getState().claude
      expect(claude?.session?.usedPercent).toBe(23.5)
      expect(claude?.weekly?.usedPercent).toBe(62)
      expect(claude?.usageMetadata?.source).toBe('live-session')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restore the outgoing account auth snapshot when the account switches mid-resolve', async () => {
    vi.useFakeTimers()
    try {
      const staleClaudeFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(() => staleClaudeFetch.promise)
        .mockImplementation(async () => okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()

      const authGate = deferred<void>()
      let resolverCalls = 0
      const service = new RateLimitService()
      service.setClaudeAuthPreparationResolver(async () => {
        resolverCalls += 1
        const outgoing = resolverCalls === 1
        if (outgoing) {
          await authGate.promise
        }
        return {
          configDir: outgoing ? '/outgoing/.claude' : '/incoming/.claude',
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: {
            CLAUDE_CONFIG_DIR: outgoing ? '/outgoing/.claude' : '/incoming/.claude'
          },
          stripAuthEnv: false,
          provenance: outgoing ? 'managed:outgoing' : 'managed:incoming'
        }
      })

      // The first cycle is parked inside the outgoing account's resolver await when the switch lands.
      const firstRefresh = service.refresh()
      await flushMicrotasks()
      const switchPromise = service.refreshForClaudeAccountChange('outgoing-account')
      await flushMicrotasks()
      authGate.resolve()
      await flushMicrotasks(8)

      // The stale cycle resumed after the switch; while its Claude fetch is still in flight,
      // a live post from the outgoing session must not land on the incoming account's bar.
      const beforeOutgoingPost = service.getState().claude?.session?.usedPercent
      service.ingestLiveClaudeRateLimits({
        configDir: '/outgoing/.claude',
        fiveHour: { used_percentage: 99 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(beforeOutgoingPost)

      staleClaudeFetch.resolve(okProvider('claude', 18))
      await Promise.all([firstRefresh, switchPromise])

      // The incoming account's own sessions still attribute correctly.
      service.ingestLiveClaudeRateLimits({
        configDir: '/incoming/.claude',
        fiveHour: { used_percentage: 55 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(55)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('refreshAfterClaudeLivePtysDrained', () => {
    function deferredClaudeResult(): ProviderRateLimits {
      return {
        ...errorProvider('claude', 'Waiting for Claude session'),
        usageMetadata: {
          failureKind: 'deferred-by-live-session',
          deferredByLiveClaudeSession: true
        }
      }
    }

    it('refetches Claude usage when the current result was deferred by a live session', async () => {
      const service = new RateLimitService()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(deferredClaudeResult())
      await service.refresh()
      expect(service.getState().claude?.usageMetadata?.deferredByLiveClaudeSession).toBe(true)
      vi.mocked(fetchClaudeRateLimits).mockClear()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

      await service.refreshAfterClaudeLivePtysDrained()

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().claude?.status).toBe('ok')
    })

    it('does not refetch when the current Claude result was not deferred', async () => {
      const service = new RateLimitService()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(
        errorProvider('claude', 'Token expired')
      )
      await service.refresh()
      vi.mocked(fetchClaudeRateLimits).mockClear()

      await service.refreshAfterClaudeLivePtysDrained()

      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    })

    it('does not refetch when there is no Claude state yet', async () => {
      const service = new RateLimitService()

      await service.refreshAfterClaudeLivePtysDrained()

      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    })
  })
})
