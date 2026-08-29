import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import {
  deferred,
  errorProvider,
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

function serviceInternals(service: RateLimitService): { fetchAll: () => Promise<void> } {
  return service as unknown as { fetchAll: () => Promise<void> }
}

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('does not reread Grok auth when callers read state snapshots', () => {
    vi.mocked(readGrokAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'token',
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs: null,
        oidcClientId: null
      }
    })
    const service = new RateLimitService()
    vi.mocked(readGrokAuthSession).mockClear()

    expect(service.getState().grokAuthConfigured).toBe(true)
    service.getState()

    expect(readGrokAuthSession).not.toHaveBeenCalled()
  })

  it('refreshes Grok without refreshing other providers', async () => {
    const authReadResult = {
      status: 'ok' as const,
      session: {
        accessToken: 'token',
        userId: null,
        email: 'dev@example.com',
        teamId: null,
        expiresAtMs: null,
        oidcClientId: null
      }
    }
    vi.mocked(readGrokAuthSession).mockReturnValue(authReadResult)
    vi.mocked(fetchGrokRateLimits).mockResolvedValueOnce(okProvider('grok', 42))
    const service = new RateLimitService()

    await service.refreshGrok()

    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGrokRateLimits).toHaveBeenCalledWith({
      authReadResult,
      signal: expect.any(AbortSignal)
    })
    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(fetchGeminiRateLimits).not.toHaveBeenCalled()
    expect(fetchOpenCodeGoRateLimits).not.toHaveBeenCalled()
    expect(fetchKimiRateLimits).not.toHaveBeenCalled()
    expect(fetchMiniMaxRateLimits).not.toHaveBeenCalled()
    expect(service.getState().grokAuthConfigured).toBe(true)
    expect(service.getState().grok?.status).toBe('ok')
  })

  it('does not refetch Claude when a Codex account switch is queued during fetchAll', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => firstClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockResolvedValueOnce(okProvider('codex', 42))

    const fullRefresh = service.refresh()
    await Promise.resolve()

    const switchRefresh = service.refreshForCodexAccountChange()
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 18))
    firstCodex.resolve(okProvider('codex', 24))

    await fullRefresh
    await switchRefresh

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('keeps recent stale data across repeated failures', async () => {
    const service = new RateLimitService()
    const internal = serviceInternals(service)

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 33, Date.now()))
      .mockResolvedValueOnce(errorProvider('claude', 'temporary failure'))
      .mockResolvedValueOnce(errorProvider('claude', 'still failing'))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))

    await internal.fetchAll()
    await internal.fetchAll()

    let state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)

    await internal.fetchAll()

    state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)
    expect(state.claude?.error).toBe('still failing')
  })

  it('bypasses the debounce for explicit manual refreshes', async () => {
    const service = new RateLimitService()

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
      .mockResolvedValueOnce(okProvider('claude', 11, Date.now()))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 21, Date.now()))

    await service.refresh()
    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('does not refetch fresh provider data for replayed mobile subscriptions', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))

    await service.refreshIfStale()
    await service.refreshIfStale()
    await service.refreshIfStale()

    expect(fetchClaudeRateLimits).toHaveBeenCalledOnce()
    expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
  })

  it('does not queue a follow-up fetch when a mobile subscription replays mid-fetch', async () => {
    const service = new RateLimitService()
    const claude = deferred<ProviderRateLimits>()
    const codex = deferred<ProviderRateLimits>()
    vi.mocked(fetchClaudeRateLimits).mockReturnValue(claude.promise)
    vi.mocked(fetchCodexRateLimits).mockReturnValue(codex.promise)

    const firstRefresh = service.refreshIfStale()
    await Promise.resolve()
    const replayedRefresh = service.refreshIfStale()

    claude.resolve(okProvider('claude', 10))
    codex.resolve(okProvider('codex', 20))
    await firstRefresh
    await replayedRefresh

    expect(fetchClaudeRateLimits).toHaveBeenCalledOnce()
    expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
  })

  it('waits for a queued explicit refresh when another fetch is already in flight', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()
    const secondClaude = deferred<ProviderRateLimits>()
    const secondCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(() => firstClaude.promise)
      .mockImplementationOnce(() => secondClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockImplementationOnce(() => secondCodex.promise)

    const backgroundFetch = serviceInternals(service).fetchAll()
    await Promise.resolve()

    let refreshResolved = false
    const manualRefresh = service.refresh().then(() => {
      refreshResolved = true
    })
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 10, Date.now()))
    firstCodex.resolve(okProvider('codex', 20, Date.now()))
    await Promise.resolve()

    expect(refreshResolved).toBe(false)

    secondClaude.resolve(okProvider('claude', 11, Date.now()))
    secondCodex.resolve(okProvider('codex', 21, Date.now()))
    await backgroundFetch
    await manualRefresh

    expect(refreshResolved).toBe(true)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('publishes non-Grok provider results before a slow Grok fetch completes', async () => {
    const service = new RateLimitService()
    const grok = deferred<ProviderRateLimits>()
    let refreshResolved = false

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )
    vi.mocked(fetchKimiRateLimits).mockResolvedValueOnce(okProvider('kimi', 50, Date.now()))
    vi.mocked(fetchMiniMaxRateLimits).mockResolvedValueOnce(okProvider('minimax', 60, Date.now()))
    vi.mocked(fetchGrokRateLimits).mockReturnValueOnce(grok.promise)

    const refresh = service.refresh().then(() => {
      refreshResolved = true
    })
    await flushMicrotasks()

    const pendingGrokState = service.getState()
    expect(pendingGrokState.claude?.status).toBe('ok')
    expect(pendingGrokState.codex?.status).toBe('ok')
    expect(pendingGrokState.gemini?.status).toBe('ok')
    expect(pendingGrokState.opencodeGo?.status).toBe('ok')
    expect(pendingGrokState.kimi?.status).toBe('ok')
    expect(pendingGrokState.minimax?.status).toBe('ok')
    expect(pendingGrokState.grok?.status).toBe('fetching')
    expect(refreshResolved).toBe(false)

    grok.resolve(okProvider('grok', 70, Date.now()))
    await refresh

    const completedState = service.getState()
    expect(completedState.grok?.status).toBe('ok')
    expect(refreshResolved).toBe(true)
  })

  it('aborts the active fetch cycle and clears queued refreshes on stop', async () => {
    const service = new RateLimitService()
    const capturedSignals: { claude?: AbortSignal; codex?: AbortSignal; grok?: AbortSignal } = {}

    vi.mocked(fetchClaudeRateLimits).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          capturedSignals.claude = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('claude', 'aborted')),
            { once: true }
          )
        })
    )
    vi.mocked(fetchCodexRateLimits).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          capturedSignals.codex = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('codex', 'aborted')),
            { once: true }
          )
        })
    )
    vi.mocked(fetchGrokRateLimits).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          capturedSignals.grok = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('grok', 'aborted')),
            { once: true }
          )
        })
    )

    const activeFetch = serviceInternals(service).fetchAll()
    await Promise.resolve()
    await Promise.resolve()

    const queuedRefresh = service.refresh()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.claude?.aborted).toBe(true)
    expect(capturedSignals.codex?.aborted).toBe(true)
    expect(capturedSignals.grok?.aborted).toBe(true)

    await queuedRefresh
    await activeFetch

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGrokRateLimits).toHaveBeenCalledTimes(1)
  })

  it('fetches Gemini and OpenCode Go alongside Claude and Codex', async () => {
    const service = new RateLimitService()
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: 'session=abc123',
      workspaceIdOverride: ''
    }))
    const networkProxySettings = {
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost'
    }
    service.setNetworkProxySettingsResolver(() => networkProxySettings)
    service.setGeminiCliOAuthEnabledResolver(() => true)

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchClaudeRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        authPreparation: undefined,
        allowPtyFallback: false,
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledWith(true)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledWith(
      'session=abc123',
      undefined,
      networkProxySettings
    )
    expect(fetchGrokRateLimits).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      authReadResult: { status: 'missing' }
    })

    const state = service.getState()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
    expect(state.codex?.status).toBe('ok')
    expect(state.codex?.session?.usedPercent).toBe(20)
    expect(state.gemini?.status).toBe('ok')
    expect(state.gemini?.session?.usedPercent).toBe(30)
    expect(state.opencodeGo?.status).toBe('ok')
    expect(state.opencodeGo?.session?.usedPercent).toBe(40)
  })

  it('passes the resolved Kimi home into each fetch cycle', async () => {
    const service = new RateLimitService()
    const home = {
      runtime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    }
    const resolver = vi.fn(async () => home)
    service.setKimiHomeResolver(resolver)
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10))

    await service.refresh()
    await service.refresh()

    // Resolved per cycle so a runtime-policy change takes effect without a restart.
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(fetchKimiRateLimits).toHaveBeenCalledWith({ home })
  })

  it('reads the host Kimi home when no resolver is wired', async () => {
    const service = new RateLimitService()
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10))

    await service.refresh()

    expect(fetchKimiRateLimits).toHaveBeenCalledWith({ home: undefined })
  })

  it('preserves Gemini buckets through getState after fetch', async () => {
    const service = new RateLimitService()

    const geminiWithBuckets: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(geminiWithBuckets)
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 0, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.buckets).toHaveLength(2)
    expect(state.gemini?.buckets![0].name).toBe('Pro')
    expect(state.gemini?.buckets![1].name).toBe('Flash')
    // Why: session summary is derived from bucket data and must match the most constrained bucket.
    expect(state.gemini?.session?.usedPercent).toBe(80)
  })

  it('isolates provider failures so one error does not block others', async () => {
    const service = new RateLimitService()
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: '',
      workspaceIdOverride: ''
    }))

    vi.mocked(fetchClaudeRateLimits).mockRejectedValueOnce(new Error('claude down'))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockRejectedValueOnce(new Error('gemini down'))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.error).toBe('claude down')
    expect(state.codex?.status).toBe('ok')
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('gemini down')
    expect(state.opencodeGo?.status).toBe('ok')
  })

  it('discards stale data when a provider becomes unavailable', async () => {
    const service = new RateLimitService()
    let cookie = 'session=valid'
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: cookie,
      workspaceIdOverride: ''
    }))

    // 1. Success fetch
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Clear cookie -> should become unavailable and LOSE the 40% data
    cookie = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'Session cookie not configured',
      status: 'unavailable'
    })

    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('unavailable')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('Session cookie not configured')
  })

  it('discards stale data when Workspace ID override is changed', async () => {
    const service = new RateLimitService()
    let workspaceId = 'wrk_A'
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: 'session=valid',
      workspaceIdOverride: workspaceId
    }))

    // 1. Success fetch for Workspace A
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Change Workspace ID to B -> old data from A should be discarded
    workspaceId = 'wrk_B'
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 10, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(10)

    // 3. Clear Workspace ID (automatic) but it fails -> should show error, NOT stale data from B
    workspaceId = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No workspace ID found',
      status: 'error'
    })
    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('No workspace ID found')
  })
})
