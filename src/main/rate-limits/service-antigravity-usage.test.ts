import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getDefaultSettings } from '../../shared/constants'
import { createAccountRuntimeTargetSettingsSync } from './account-runtime-target-sync'
import { getAntigravityUsageTarget } from './antigravity-usage-runtime'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
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

function antigravityReading(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: { usedPercent, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    status: 'ok',
    error: null,
    updatedAt: Date.now()
  }
}

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
  })

  it('continues the provider cycle when persisted WSL distro settings are not a string', async () => {
    const settings = Object.assign(getDefaultSettings('/tmp'), {
      localAccountRuntime: 'wsl' as const,
      localAccountWslDistro: 42
    })
    const service = new RateLimitService()
    service.setAntigravityUsageTargetResolver(() => getAntigravityUsageTarget(settings, 'win32'))
    await service.refresh()
    expect(service.getState().claude?.status).toBe('ok')
    expect(service.getState().codex?.status).toBe('ok')
    expect(service.getState().antigravity?.status).toBe('ok')
    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { runtime: 'wsl', wslDistro: null } })
    )
  })

  it('completes a settings change that retargets Claude, Codex, and Antigravity together', async () => {
    let settings: GlobalSettings = { ...getDefaultSettings('/tmp'), localAccountRuntime: 'host' }
    const service = new RateLimitService()
    service.setCodexHomePathResolver(async () => ({
      kind: 'ready',
      codexHomePath: '/tmp/orca-settings-sync-codex-home'
    }))
    service.setAntigravityUsageTargetResolver(() => getAntigravityUsageTarget(settings, 'win32'))
    const sync = createAccountRuntimeTargetSettingsSync(service, settings, 'win32')
    settings = { ...settings, localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }
    await sync({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }, settings)
    expect(service.getState().claudeTarget).toMatchObject({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(service.getState().codexTarget).toMatchObject({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(service.getState().antigravity?.status).toBe('ok')
    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
    )
  })

  it('retains default-WSL quota while refreshing the same resolved distro', async () => {
    const service = new RateLimitService()
    service.setAntigravityUsageTargetResolver(() => ({ runtime: 'wsl', wslDistro: null }))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
      ...antigravityReading(42),
      usageMetadata: { authProvenance: 'wsl:ubuntu' }
    })
    await service.refresh()
    const response = deferred<ProviderRateLimits>()
    const started = deferred<void>()
    vi.mocked(fetchAntigravityRateLimits).mockImplementationOnce(() => {
      started.resolve()
      return response.promise
    })
    const refreshing = service.refresh()
    await started.promise
    expect(service.getState().antigravity?.weekly?.usedPercent).toBe(42)
    response.resolve({
      ...antigravityReading(43),
      usageMetadata: { authProvenance: 'wsl:ubuntu' }
    })
    await refreshing
    expect(service.getState().antigravity?.weekly?.usedPercent).toBe(43)
  })

  it('queues a settings refresh even when Claude and Codex already target that distro', async () => {
    let settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      localAccountRuntime: 'wsl' as const,
      localAccountWslDistro: null
    }
    const service = new RateLimitService()
    service.setClaudeFetchTarget({ runtime: 'wsl', wslDistro: 'ubuntu' })
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'ubuntu' })
    service.setAntigravityUsageTargetResolver(() => getAntigravityUsageTarget(settings, 'win32'))
    const sync = createAccountRuntimeTargetSettingsSync(service, settings, 'win32')
    const response = deferred<ProviderRateLimits>()
    const started = deferred<void>()
    vi.mocked(fetchAntigravityRateLimits)
      .mockImplementationOnce(() => {
        started.resolve()
        return response.promise
      })
      .mockResolvedValueOnce({
        ...antigravityReading(77),
        usageMetadata: { authProvenance: 'wsl:ubuntu' }
      })
    const refreshing = service.refresh()
    await started.promise
    settings = { ...settings, localAccountWslDistro: 'ubuntu' }
    const applyingSettings = sync({ localAccountWslDistro: 'ubuntu' }, settings)
    expect(service.getState().antigravity).toBeNull()
    response.resolve({
      ...antigravityReading(42),
      usageMetadata: { authProvenance: 'wsl:ubuntu' }
    })
    await Promise.all([refreshing, applyingSettings])

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().antigravity?.weekly?.usedPercent).toBe(77)
  })

  it('does not retain host quota when the selected WSL runtime fails', async () => {
    let target: LocalAccountRuntimeTarget = { runtime: 'host', wslDistro: null }
    const service = new RateLimitService()
    service.setAntigravityUsageTargetResolver(() => target)
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
      ...antigravityReading(30),
      usageMetadata: { authProvenance: 'host' }
    })
    await service.refresh()
    target = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
      ...errorProvider('antigravity', 'WSL unavailable'),
      usageMetadata: { authProvenance: 'wsl:ubuntu' }
    })
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('error')
    expect(service.getState().antigravity?.weekly).toBeNull()
    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(expect.objectContaining({ target }))
  })

  it('keeps sign-in cooldowns on their runtime when an automated refresh changes targets', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      let target: LocalAccountRuntimeTarget = { runtime: 'host', wslDistro: null }
      const service = new RateLimitService()
      service.setAntigravityUsageTargetResolver(() => target)
      vi.mocked(fetchAntigravityRateLimits)
        .mockResolvedValueOnce({
          ...unavailableProvider('antigravity', 'Sign in with `agy`'),
          usageMetadata: {
            authProvenance: 'host',
            failureKind: 'missing-credentials',
            retryAtMs: Date.now() + 60 * 60 * 1000
          }
        })
        .mockResolvedValueOnce({
          ...antigravityReading(42),
          usageMetadata: { authProvenance: 'wsl:ubuntu' }
        })
      await service.refresh()

      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await service.refreshIfStale()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().antigravity?.status).toBe('unavailable')

      target = { runtime: 'wsl', wslDistro: 'Ubuntu' }
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await service.refreshIfStale()
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(expect.objectContaining({ target }))
      expect(service.getState().antigravity).toMatchObject({
        status: 'ok',
        weekly: { usedPercent: 42 },
        usageMetadata: { authProvenance: 'wsl:ubuntu' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards an in-flight quota result when the runtime selection changes', async () => {
    let target: LocalAccountRuntimeTarget = { runtime: 'host', wslDistro: null }
    const service = new RateLimitService()
    service.setAntigravityUsageTargetResolver(() => target)
    const result = deferred<ProviderRateLimits>()
    const started = deferred<void>()
    vi.mocked(fetchAntigravityRateLimits).mockImplementationOnce(() => {
      started.resolve()
      return result.promise
    })
    const refreshing = service.refresh()
    await started.promise
    target = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    service.invalidateAntigravityUsageTarget()
    result.resolve(antigravityReading(30))
    await refreshing
    expect(service.getState().antigravity).toBeNull()

    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
      ...antigravityReading(80),
      usageMetadata: { authProvenance: 'wsl:ubuntu' }
    })
    await service.refresh()
    expect(service.getState().antigravity?.weekly?.usedPercent).toBe(80)
  })

  it('does not resurrect an old runtime snapshot while resolving another provider home', async () => {
    let target: LocalAccountRuntimeTarget = { runtime: 'host', wslDistro: null }
    const service = new RateLimitService()
    service.setAntigravityUsageTargetResolver(() => target)
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(antigravityReading(30))
    await service.refresh()
    const home = deferred<{ kind: 'ready'; codexHomePath: null }>()
    const entered = deferred<void>()
    service.setCodexHomePathResolver(() => {
      entered.resolve()
      return home.promise
    })
    const refreshing = service.refresh()
    await entered.promise
    target = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    service.invalidateAntigravityUsageTarget()
    const afterSwitch: (number | undefined)[] = []
    service.onStateChange((state) => {
      afterSwitch.push(state.antigravity?.weekly?.usedPercent)
    })
    home.resolve({ kind: 'ready', codexHomePath: null })
    await refreshing

    expect(service.getState().antigravity).toBeNull()
    expect(afterSwitch.every((value) => value === undefined)).toBe(true)
    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
  })

  it('publishes the Antigravity CLI reading, not the Gemini one', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    // Why both: the mirror made these two numbers the same value by construction.
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
    // Why: the two providers no longer share a credential or an endpoint, so a Gemini
    // token problem is not evidence about Antigravity quota (#9122).
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
    // Why: a thrown Antigravity fetch must not abort the cycle for everyone else.
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

    // Why: the probe starts the agy language server for ~2.5 s. A user not showing the meter
    // should not pay that every cycle.
    expect(fetchAntigravityRateLimits).not.toHaveBeenCalled()
    expect(service.getState().antigravity?.status).toBe('idle')
    // Why the rest must be untouched: gating one provider cannot gate the cycle.
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

  it('fetches when no resolver is configured', async () => {
    // Why default-on: the status bar shows Antigravity by default, so an unconfigured service
    // must still fill the meter rather than silently reporting nothing.
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()

    await service.refresh()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
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

    // Why kept: hiding the meter is not evidence the quota changed, and re-showing it should not
    // flash an empty segment while the next poll runs.
    expect(service.getState().antigravity?.session?.usedPercent).toBe(44)
    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
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
