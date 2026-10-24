import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
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

class ObservedRateLimitService extends RateLimitService {
  get claudeCheckCompletedAt(): number | null {
    return this.lastClaudeCheckCompletedAt
  }

  get activeRefreshPlan() {
    return this.getActiveWindowRefreshPlan(Date.now())
  }
}

const profileRouter = vi.hoisted((): { userConfigDir?: string } => ({}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    profileRouter.userConfigDir ? { userConfigDir: () => profileRouter.userConfigDir } : undefined
}))

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

  it.each(['equal', 'session-only growth'])(
    'corrects %s replays on timer ticks',
    async (report) => {
      vi.useFakeTimers()
      try {
        let checks = 0
        vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => ({
          ...okProvider('claude', 10),
          weekly: {
            usedPercent: ++checks < 3 ? 25 : 40,
            windowMinutes: 10080,
            resetsAt: null,
            resetDescription: null
          }
        }))
        mockFreshBackgroundProviderFetches()
        const service = new RateLimitService()
        service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
        service.start({ fetchImmediately: false })
        await vi.advanceTimersByTimeAsync(1000)

        for (let minute = 1; minute <= 30; minute += 1) {
          service.ingestLiveClaudeRateLimits({
            configDir: null,
            fiveHour: { used_percentage: report === 'equal' ? 10 : 10 + minute },
            sevenDay: report === 'equal' ? { used_percentage: 25 } : null
          })
          await vi.advanceTimersByTimeAsync(60 * 1000)
          if (minute === 15 || minute === 30) {
            expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1 + minute / 15)
            expect(service.getState().claude?.weekly?.usedPercent).toBe(minute === 15 ? 25 : 40)
          }
        }
        service.stop()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps polling on cadence for an account with a Fable window the live feed cannot carry', async () => {
    vi.useFakeTimers()
    try {
      const withFable = (usedPercent: number): ProviderRateLimits => ({
        ...okProvider('claude', 40),
        fableWeekly: { usedPercent, windowMinutes: 10080, resetsAt: null, resetDescription: null }
      })
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => withFable(18))
        .mockImplementation(async () => withFable(39))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(18)

      // Statusline posts land every minute, so the live snapshot never ages past the freshness window.
      for (let minute = 0; minute < 15; minute += 1) {
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour: { used_percentage: 50 + minute },
          sevenDay: { used_percentage: 30 }
        })
        await vi.advanceTimersByTimeAsync(60 * 1000)
      }

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(39)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours a Retry-After that lands while the live feed is fresh', async () => {
    vi.useFakeTimers()
    try {
      const withFable: ProviderRateLimits = {
        ...okProvider('claude', 40),
        fableWeekly: {
          usedPercent: 18,
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: null
        }
      }
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => withFable)
        .mockImplementation(async () => ({
          ...errorProvider('claude', 'Claude usage is rate limited right now.'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 60 * 60 * 1000 }
        }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)

      // The Fable account keeps polling under live posts; the second poll is a 429 with a one-hour Retry-After.
      for (let minute = 0; minute < 60; minute += 1) {
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour: { used_percentage: 40 + minute * 0.5 },
          sevenDay: { used_percentage: 30 }
        })
        await vi.advanceTimersByTimeAsync(60 * 1000)
      }

      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.session?.usedPercent).toBe(69.5)

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a Retry-After window closed after a live post clears the error', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockImplementation(async () => ({
        ...errorProvider('claude', 'Claude usage is rate limited right now.'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: Date.now() + 50 * 60 * 1000 }
      }))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 23.5 },
        sevenDay: { used_percentage: 41.2 }
      })
      expect(service.getState().claude?.status).toBe('ok')

      // Two poll cycles inside the Retry-After window, long after the live post went stale: no OAuth call.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

      // Once Retry-After expires, polling resumes.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

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

  it('attributes statusline posts to System Default when it inherits CLAUDE_CONFIG_DIR', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/own/claude-config')
      const service = new RateLimitService()
      service.setClaudeAuthPreparationResolver(async () => ({
        configDir: '/own/claude-config',
        envPatch: {},
        provenance: 'system'
      }))
      await service.refresh()
      service.ingestLiveClaudeRateLimits({
        configDir: '/own/claude-config',
        fiveHour: { used_percentage: 44 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(44)
    } finally {
      vi.unstubAllEnvs()
      vi.useRealTimers()
    }
  })

  it("attributes System Default posts to the login shell's CLAUDE_CONFIG_DIR a Dock launch lacks", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()
      vi.stubEnv('CLAUDE_CONFIG_DIR', '')
      profileRouter.userConfigDir = '/shell/claude-config'
      const service = new RateLimitService()
      service.setClaudeAuthPreparationResolver(async () => ({
        configDir: '/shell/claude-config',
        envPatch: {},
        provenance: 'system'
      }))
      await service.refresh()
      service.ingestLiveClaudeRateLimits({
        configDir: '/shell/claude-config',
        fiveHour: { used_percentage: 44 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(44)
    } finally {
      profileRouter.userConfigDir = undefined
      vi.unstubAllEnvs()
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

  it('starts a recreated service without the previous live usage or check cooldown', async () => {
    vi.useFakeTimers()
    const previous = new ObservedRateLimitService()
    let recreated: ObservedRateLimitService | undefined
    try {
      const previousCompletedAt = Date.now()
      const retryAtMs = previousCompletedAt + 60 * 60 * 1000
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => ({
          ...errorProvider('claude', 'rate limited'),
          usageMetadata: { failureKind: 'rate-limited', retryAtMs }
        }))
        .mockImplementationOnce(async () => okProvider('claude', 8))
      mockFreshBackgroundProviderFetches()
      await previous.refresh()
      previous.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: { used_percentage: 25 }
      })
      expect(previous.getState().claude).toMatchObject({
        status: 'ok',
        session: { usedPercent: 41 },
        weekly: { usedPercent: 25 },
        usageMetadata: { source: 'live-session', retryAtMs }
      })
      expect(previous.claudeCheckCompletedAt).toBe(previousCompletedAt)
      previous.stop()

      recreated = new ObservedRateLimitService()
      expect(recreated.getState().claudeTarget).toEqual(previous.getState().claudeTarget)
      expect(recreated.getState().claude).toBeNull()
      expect(recreated.claudeCheckCompletedAt).toBeNull()
      recreated.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      recreated.start({ fetchImmediately: false })
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(Date.now()).toBeLessThan(retryAtMs)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(recreated.getState().claude).toMatchObject({
        status: 'ok',
        session: { usedPercent: 8 },
        updatedAt: Date.now()
      })
      expect(recreated.getState().claude?.usageMetadata?.retryAtMs).toBeUndefined()
      expect(recreated.claudeCheckCompletedAt).toBe(Date.now())
    } finally {
      previous.stop()
      recreated?.stop()
      vi.useRealTimers()
    }
  })

  it.each(['focus', 'mobile'])('paces %s checks by completion', async (trigger) => {
    vi.useFakeTimers()
    try {
      const parkedClaudeFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 18))
        .mockImplementationOnce(() => parkedClaudeFetch.promise)
        .mockImplementation(async () => okProvider('claude', 8))
      mockFreshBackgroundProviderFetches()
      const service = new ObservedRateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      const activate = async () => {
        if (trigger === 'mobile') {
          await service.refreshIfStale()
        } else {
          window.emit('focus')
        }
        await vi.advanceTimersByTimeAsync(0)
      }
      await service.refresh()
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const secondRefresh = service.refresh()
      await flushMicrotasks()
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: null
      })
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const completedAt = Date.now()
      const retryAtMs = completedAt + 4.5 * 60 * 1000
      parkedClaudeFetch.resolve({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs }
      })
      await secondRefresh
      expect(service.getState().claude?.session?.usedPercent).toBe(41)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(retryAtMs)
      expect(service.claudeCheckCompletedAt).toBe(completedAt)
      await service.refreshIfStale()
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)

      // Other providers become stale first; their full cycle cannot move Claude's gated clock.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      await service.refreshIfStale()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(3)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(service.claudeCheckCompletedAt).toBe(completedAt)
      await vi.advanceTimersByTimeAsync(60 * 1000 - 1)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 41 },
        sevenDay: null
      })
      await service.refreshIfStale()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      // Only Claude is due, despite a fresh equal receipt and fresh other providers.
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().claude?.session?.usedPercent).toBe(8)
      await service.refreshIfStale()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)

      // A second failure keeps Claude gated beyond its five-minute check age.
      const cooldownFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => cooldownFetch.promise)
      const cooldownRefresh = service.refresh()
      await flushMicrotasks()
      const postLive = () =>
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour: { used_percentage: 41 },
          sevenDay: null
        })
      postLive()
      await vi.advanceTimersByTimeAsync(60 * 1000)
      const cooldownCompletedAt = Date.now()
      const cooldownRetryAtMs = cooldownCompletedAt + 60 * 60 * 1000
      cooldownFetch.resolve({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: cooldownRetryAtMs }
      })
      await cooldownRefresh
      expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(cooldownRetryAtMs)
      const siblingCallsBefore = vi.mocked(fetchCodexRateLimits).mock.calls.length
      // Legitimately stale siblings refresh during cooldown without stamping Claude.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      await activate()
      const siblingCalls = siblingCallsBefore + 1
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls)
      await vi.advanceTimersByTimeAsync(60 * 1000)
      for (let event = 0; event < 3; event += 1) {
        await vi.advanceTimersByTimeAsync(60 * 1000)
        postLive()
        const live = service.getState().claude
        await activate()
        expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
        expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls)
        expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(siblingCalls)
        expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
        expect(service.getState().claude).toEqual(live)
      }
      // Continuing the sibling scan must still admit independently due work.
      await vi.advanceTimersByTimeAsync(60 * 1000)
      await activate()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      // Freshen siblings just before expiry, so only Claude is due at the deadline.
      await vi.advanceTimersByTimeAsync(cooldownRetryAtMs - Date.now() - 1)
      postLive()
      await activate()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 2)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      expect(service.claudeCheckCompletedAt).toBe(cooldownCompletedAt)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)
      expect(service.getState().claude?.session?.usedPercent).toBe(8)
      expect(service.claudeCheckCompletedAt).toBe(cooldownRetryAtMs)
      await activate()
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(5)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(siblingCalls + 3)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['full', 'claude-only'])('isolates %s checks on switch', async (cycle) => {
    vi.useFakeTimers()
    try {
      const staleClaudeFetch = deferred<ProviderRateLimits>()
      const incomingFetch = deferred<ProviderRateLimits>()
      vi.mocked(fetchClaudeRateLimits)
        .mockImplementationOnce(async () => okProvider('claude', 9))
        .mockImplementationOnce(() => staleClaudeFetch.promise)
        .mockImplementationOnce(() => incomingFetch.promise)
      mockFreshBackgroundProviderFetches()

      const authGate = deferred<void>()
      let resolverCalls = 0
      const service = new ObservedRateLimitService()
      await service.refresh()
      expect(service.claudeCheckCompletedAt).toBe(Date.now())
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
          provenance: outgoing ? 'managed:outgoing' : 'managed:incoming'
        }
      })

      // The first cycle is parked inside the outgoing account's resolver await when the switch lands.
      const firstRefresh = cycle === 'full' ? service.refresh() : service.refreshClaudeForTarget()
      await flushMicrotasks()
      const switchPromise =
        cycle === 'full'
          ? service.refreshForClaudeAccountChange('outgoing-account')
          : service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
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
      await vi.advanceTimersByTimeAsync(0)
      expect(service.claudeCheckCompletedAt).toBeNull()

      // The incoming account's own sessions still attribute correctly.
      service.ingestLiveClaudeRateLimits({
        configDir: '/incoming/.claude',
        fiveHour: { used_percentage: 55 },
        sevenDay: null
      })
      expect(service.getState().claude?.session?.usedPercent).toBe(55)
      expect(service.activeRefreshPlan).toEqual({ kind: 'full' })
      incomingFetch.resolve(okProvider('claude', 18))
      await Promise.all([firstRefresh, switchPromise])
      expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
      expect(service.claudeCheckCompletedAt).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the newer weekly value when an idle session re-posts an older one for the same window', async () => {
    vi.useFakeTimers()
    try {
      // OAuth resets carry sub-second precision; the statusline reports whole seconds.
      const sessionReset = Date.now() + 128 * 60 * 1000 + 123
      const weeklyReset = Date.now() + 125 * 60 * 60 * 1000 + 456
      const win = (usedPercent: number, resetsAt: number, windowMinutes: number) => ({
        usedPercent,
        windowMinutes,
        resetsAt,
        resetDescription: null
      })
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue({
        ...okProvider('claude', 10),
        session: win(10, sessionReset, 300),
        weekly: win(25, weeklyReset, 10080)
      })
      mockFreshBackgroundProviderFetches()
      const service = new RateLimitService()
      await service.refresh()
      const fetched = service.getState().claude
      const post = (session: number | null, weekly: number, weeklyResetAt = weeklyReset) =>
        service.ingestLiveClaudeRateLimits({
          configDir: null,
          fiveHour:
            session === null
              ? null
              : { used_percentage: session, resets_at: Math.floor(sessionReset / 1000) },
          sevenDay: { used_percentage: weekly, resets_at: Math.floor(weeklyResetAt / 1000) }
        })

      // An idle session last saw the API days ago: Claude Code drops its passed 5-hour window but
      // still reports the current weekly window at the old value. Dropped whole, so the OAuth poll is not deferred.
      await vi.advanceTimersByTimeAsync(60 * 1000)
      post(null, 8)
      expect(service.getState().claude).toEqual(fetched)

      post(10, 8)
      expect(service.getState().claude).toEqual(fetched)
      post(null, 90, weeklyReset - 7 * 24 * 60 * 60 * 1000)
      expect(service.getState().claude).toEqual(fetched)
      vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60 * 1000, failureKind: 'rate-limited' }
      })
      await service.refresh()
      const failed = service.getState().claude
      post(10, 8)
      expect(service.getState().claude).toEqual(failed)
      post(10, 25)
      expect(service.getState().claude?.session?.resetsAt).toBe(sessionReset)
      expect(service.getState().claude?.status).toBe('ok')
      expect(service.getState().claude?.usageMetadata?.retryAtMs).toBe(
        failed?.usageMetadata?.retryAtMs
      )
      post(11, 25)
      expect(service.getState().claude?.weekly?.resetsAt).toBe(weeklyReset)
      const grownSessionReset = service.getState().claude?.session?.resetsAt
      post(11, 26)
      expect(service.getState().claude?.session?.resetsAt).toBe(grownSessionReset)
      expect(service.getState().claude?.weekly?.usedPercent).toBe(26)

      // A new weekly window's lower value is taken.
      post(null, 1, weeklyReset + 7 * 24 * 60 * 60 * 1000)
      expect(service.getState().claude?.weekly?.usedPercent).toBe(1)
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: null,
        sevenDay: { utilization: 0 }
      })
      expect(service.getState().claude?.weekly?.usedPercent).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
