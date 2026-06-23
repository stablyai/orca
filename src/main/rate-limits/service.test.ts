/* eslint-disable max-lines -- Why: these tests mirror the fetch ordering,
stale-data handling, account-switch generation, and OpenCode config-change
semantics covered in service.ts, which already carries the same pragma.
Keeping them in one file makes the ordering contract reviewable as a unit. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function okProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
  usedPercent: number,
  updatedAt = Date.now()
): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function errorProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
  message: string
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'error'
  }
}

function serviceInternals(service: RateLimitService): { fetchAll: () => Promise<void> } {
  return service as unknown as { fetchAll: () => Promise<void> }
}

type RateLimitWindow = Parameters<RateLimitService['attach']>[0]

class FakeRateLimitWindow extends EventEmitter {
  focused = true
  minimized = false
  visible = true

  webContents = {
    send: vi.fn()
  }

  isDestroyed(): boolean {
    return false
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isFocused(): boolean {
    return this.focused
  }
}

function asRateLimitWindow(window: FakeRateLimitWindow): RateLimitWindow {
  return window as unknown as RateLimitWindow
}

describe('RateLimitService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(okProvider('opencode-go', 0, Date.now()))
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

  it('fetches Gemini and OpenCode Go alongside Claude and Codex', async () => {
    const service = new RateLimitService()
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: 'session=abc123',
      workspaceIdOverride: ''
    }))
    service.setGeminiCliOAuthEnabledResolver(() => true)

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchClaudeRateLimits).toHaveBeenCalledWith({
      authPreparation: undefined,
      allowPtyFallback: true
    })
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledWith(true)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledWith('session=abc123', undefined)

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

  it('passes the selected WSL Codex home into active account rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    const resolver = vi.fn((target) => (target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome))
    service.setCodexHomePathResolver(resolver)

    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refreshForCodexAccountChange(null, { runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: wslCodexHome })
    )
  })

  it('uses the initialized WSL target for active Codex rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    const resolver = vi.fn((target) => (target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome))
    service.setCodexHomePathResolver(resolver)
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: wslCodexHome })
    )
  })

  it('does not fetch host Codex usage when WSL home resolution fails', async () => {
    const service = new RateLimitService()
    const resolver = vi.fn(() => null)
    service.setCodexHomePathResolver(resolver)
    service.setCodexFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(service.getState().codex).toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'WSL Codex home unavailable for Ubuntu'
    })
  })

  it('uses the initialized WSL target for active Claude rate-limit fetches', async () => {
    const service = new RateLimitService()
    const resolver = vi.fn(async (target) => ({
      configDir:
        target?.runtime === 'wsl'
          ? '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
          : 'C:\\Users\\jin\\.claude',
      runtime: target?.runtime ?? 'host',
      wslDistro: target?.wslDistro ?? null,
      wslLinuxConfigDir: target?.runtime === 'wsl' ? '/home/jin/.claude' : null,
      envPatch: target?.runtime === 'wsl' ? { CLAUDE_CONFIG_DIR: '/home/jin/.claude' } : {},
      stripAuthEnv: target?.runtime === 'wsl',
      provenance: target?.runtime === 'wsl' ? 'managed:wsl-account:wsl:Ubuntu' : 'system'
    }))
    service.setClaudeAuthPreparationResolver(resolver)
    service.setClaudeFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()

    expect(resolver).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchClaudeRateLimits).toHaveBeenCalledWith({
      authPreparation: expect.objectContaining({
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxConfigDir: '/home/jin/.claude',
        stripAuthEnv: true
      }),
      allowPtyFallback: true
    })
    expect(service.getState().claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('does not cache host Codex usage under an outgoing WSL account', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    const hostCodexHome = 'C:\\Users\\jin\\.orca\\codex-accounts\\host\\home'
    service.setCodexHomePathResolver((target) =>
      target?.runtime === 'wsl' ? wslCodexHome : hostCodexHome
    )

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 40, Date.now()))

    await service.refresh()
    await service.refreshForCodexAccountChange('wsl-account-1', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(service.getState().inactiveCodexAccounts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: 'wsl-account-1' })])
    )
  })

  it('does not cache host Claude usage under an outgoing WSL account', async () => {
    const service = new RateLimitService()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'wsl-account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async (target) => ({
      configDir:
        target?.runtime === 'wsl'
          ? '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
          : 'C:\\Users\\jin\\.claude',
      runtime: target?.runtime ?? 'host',
      wslDistro: target?.wslDistro ?? null,
      wslLinuxConfigDir: target?.runtime === 'wsl' ? '/home/jin/.claude' : null,
      envPatch: {},
      stripAuthEnv: target?.runtime === 'wsl',
      provenance: target?.runtime === 'wsl' ? 'managed:wsl-account-1:wsl:Ubuntu' : 'system'
    }))

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('claude', 40, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))

    await service.refresh()
    await service.refreshForClaudeAccountChange('wsl-account-1', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(fetchClaudeRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowPtyFallback: true })
    )

    expect(service.getState().inactiveClaudeAccounts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: 'wsl-account-1' })])
    )
  })

  it('passes WSL Codex managed homes into inactive account rate-limit fetches', async () => {
    const service = new RateLimitService()
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    service.setInactiveCodexAccountsResolver(() => [
      { id: 'account-1', managedHomePath: wslCodexHome }
    ])
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 33, Date.now()))

    await service.fetchInactiveCodexAccountsOnOpen()

    expect(fetchCodexRateLimits).toHaveBeenCalledWith({
      codexHomePath: wslCodexHome,
      allowPtyFallback: false
    })
    expect(service.getState().inactiveCodexAccounts).toEqual([
      {
        accountId: 'account-1',
        rateLimits: expect.objectContaining({
          provider: 'codex',
          session: expect.objectContaining({ usedPercent: 33 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('does not start overlapping inactive Codex preview fetches', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveCodexAccountsResolver(() => [
      { id: 'account-1', managedHomePath: '/tmp/account-1/home' }
    ])
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(accountFetch.promise)

    const firstFetch = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()
    await service.fetchInactiveCodexAccountsOnOpen()

    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

    accountFetch.resolve(okProvider('codex', 50, Date.now()))
    await firstFetch
  })

  it('keeps sibling inactive Codex preview fetches alive when one account is evicted', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [
      { id: 'account-a', managedHomePath: '/tmp/account-a/home' },
      { id: 'account-b', managedHomePath: '/tmp/account-b/home' }
    ]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'account-a', rateLimits: null, updatedAt: 0, isFetching: true },
      { accountId: 'account-b', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    inactiveAccounts = [{ id: 'account-a', managedHomePath: '/tmp/account-a/home' }]
    service.evictInactiveCodexCache('account-b')
    accountFetch.resolve(okProvider('codex', 64, Date.now()))
    await fetchOnOpen

    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().inactiveCodexAccounts).toEqual([
      {
        accountId: 'account-a',
        rateLimits: expect.objectContaining({
          provider: 'codex',
          session: expect.objectContaining({ usedPercent: 64 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('does not recache an inactive Codex account that becomes active during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [{ id: 'account-b', managedHomePath: '/tmp/account-b/home' }]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    service.setCodexHomePathResolver(() => '/tmp/account-b/home')
    vi.mocked(fetchCodexRateLimits)
      .mockReturnValueOnce(accountFetch.promise)
      .mockResolvedValueOnce(okProvider('codex', 7, Date.now()))

    const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'account-b', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    inactiveAccounts = []
    await service.refreshForCodexAccountChange('account-a')
    accountFetch.resolve(okProvider('codex', 42, Date.now()))
    await fetchOnOpen

    expect(service.getState().inactiveCodexAccounts).toEqual([])
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

  it('does not recache an inactive Claude account removed during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    service.setInactiveClaudeAccountsResolver(() => inactiveAccounts)
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveClaudeAccounts).toEqual([
      { accountId: 'account-1', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    service.evictInactiveClaudeCache('account-1')
    inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    await service.refreshForClaudeAccountChange('account-1')
    expect(service.getState().inactiveClaudeAccounts[0]?.accountId).toBe('account-1')

    inactiveAccounts = []
    service.evictInactiveClaudeCache('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
  })

  it('does not overwrite inactive Claude cache from a stale same-id fetch', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()

    await service.refreshForClaudeAccountChange('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([
      {
        accountId: 'account-1',
        rateLimits: expect.objectContaining({
          provider: 'claude',
          session: expect.objectContaining({ usedPercent: 7 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })
})
