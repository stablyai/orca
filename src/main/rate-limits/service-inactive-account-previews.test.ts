import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { MIN_REFETCH_MS } from './service/service-types'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

function inactiveCodexAccount(id: string, managedHomePath: string) {
  return {
    id,
    resolveHome: () => ({ kind: 'ready' as const, managedHomePath })
  }
}

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

  it('aborts inactive Claude preview fetches on stop', async () => {
    const service = new RateLimitService()
    const account = { id: 'account-1' }
    const capturedSignals: { claude?: AbortSignal } = {}
    service.setInactiveClaudeAccountsResolver(() => [account])
    vi.mocked(fetchManagedAccountUsage).mockImplementation(
      (_account, options) =>
        new Promise((resolve) => {
          capturedSignals.claude = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve(errorProvider('claude', 'aborted')),
            { once: true }
          )
        })
    )

    const previewFetch = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.claude?.aborted).toBe(true)

    await previewFetch

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
  })

  it('logs an inactive Claude fetch and keeps a thrown keychain failure on the row', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const service = new RateLimitService()
      service.setInactiveClaudeAccountsResolver(() => [{ id: 'account-1' }, { id: 'account-2' }])
      const denied = Object.assign(new Error('User interaction is not allowed.'), { code: 36 })
      vi.mocked(fetchManagedAccountUsage)
        .mockRejectedValueOnce(denied)
        .mockResolvedValueOnce({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token', httpStatus: 401 }
        })

      await service.fetchInactiveClaudeAccountsOnOpen()

      const lines = info.mock.calls.map((call) => String(call[0]))
      expect(lines).toContain('[claude-usage] inactive fetch start n=2')
      expect(lines).toContain('[claude-usage] inactive fetch done n=2 ok=0 failed=2')
      expect(lines).toContain(
        '[claude-usage] inactive fetch account=account-1 failure=keychain-unavailable'
      )
      expect(lines).toContain(
        '[claude-usage] inactive fetch account=account-2 failure=stale-token http=401'
      )
      expect(lines.join('\n')).not.toContain('User interaction is not allowed')
      const rows = service.getState().inactiveClaudeAccounts
      expect(rows).toEqual([
        expect.objectContaining({
          accountId: 'account-1',
          rateLimits: expect.objectContaining({
            status: 'error',
            usageMetadata: expect.objectContaining({ failureKind: 'keychain-unavailable' })
          })
        }),
        expect.objectContaining({
          accountId: 'account-2',
          rateLimits: expect.objectContaining({
            status: 'error',
            usageMetadata: expect.objectContaining({ failureKind: 'stale-token', httpStatus: 401 })
          })
        })
      ])
    } finally {
      info.mockRestore()
    }
  })

  it('aborts inactive Codex preview fetches on stop', async () => {
    const service = new RateLimitService()
    const account = inactiveCodexAccount('account-1', '/tmp/account-1/home')
    const capturedSignals: { codex?: AbortSignal } = {}
    service.setInactiveCodexAccountsResolver(() => [account])
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

    const previewFetch = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.codex?.aborted).toBe(true)

    await previewFetch

    expect(service.getState().inactiveCodexAccounts).toEqual([])
  })

  it('passes WSL Codex managed homes into inactive account rate-limit fetches', async () => {
    const service = new RateLimitService()
    const networkProxySettings = { httpProxyUrl: 'http://proxy.fixture.invalid:8080' }
    service.setNetworkProxySettingsResolver(() => networkProxySettings)
    const wslCodexHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-1', wslCodexHome)
    ])
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 33, Date.now()))

    await service.fetchInactiveCodexAccountsOnOpen()

    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        codexHomePath: wslCodexHome,
        networkProxySettings,
        signal: expect.any(AbortSignal)
      })
    )
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

  it('skips an unavailable inactive home without dropping its cache and recovers later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    try {
      const service = new RateLimitService()
      let unavailable = false
      service.setInactiveCodexAccountsResolver(() => [
        {
          id: 'account-1',
          resolveHome: () =>
            unavailable
              ? { kind: 'skip' as const }
              : { kind: 'ready' as const, managedHomePath: '/tmp/account-1/home' }
        }
      ])
      vi.mocked(fetchCodexRateLimits)
        .mockResolvedValueOnce(okProvider('codex', 33, Date.now()))
        .mockResolvedValueOnce(okProvider('codex', 67, Date.now()))

      await service.fetchInactiveCodexAccountsOnOpen()
      unavailable = true
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await service.fetchInactiveCodexAccountsOnOpen()

      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
      expect(service.getState().inactiveCodexAccounts).toEqual([
        expect.objectContaining({
          accountId: 'account-1',
          isFetching: false,
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 33 })
          })
        })
      ])

      unavailable = false
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await service.fetchInactiveCodexAccountsOnOpen()

      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().inactiveCodexAccounts[0]?.rateLimits?.session?.usedPercent).toBe(67)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows usage-panel Fable supplements for inactive Claude account previews', async () => {
    const service = new RateLimitService()
    const account = { id: 'account-1' }
    service.setInactiveClaudeAccountsResolver(() => [account])
    vi.mocked(fetchManagedAccountUsage).mockResolvedValueOnce(okProvider('claude', 33, Date.now()))

    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchManagedAccountUsage).toHaveBeenCalledWith(
      account,
      expect.objectContaining({
        allowUsagePanelSupplement: true,
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('does not start overlapping inactive Claude preview fetches', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'account-1' }])
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const firstFetch = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()
    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(1)

    accountFetch.resolve(okProvider('claude', 50, Date.now()))
    await firstFetch
  })

  it('does not start overlapping inactive Codex preview fetches', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-1', '/tmp/account-1/home')
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
      inactiveCodexAccount('account-a', '/tmp/account-a/home'),
      inactiveCodexAccount('account-b', '/tmp/account-b/home')
    ]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'account-a', rateLimits: null, updatedAt: 0, isFetching: true }
    ])

    inactiveAccounts = [inactiveCodexAccount('account-a', '/tmp/account-a/home')]
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
    let inactiveAccounts = [inactiveCodexAccount('account-b', '/tmp/account-b/home')]
    service.setInactiveCodexAccountsResolver(() => inactiveAccounts)
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/tmp/account-b/home'
    }))
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

  it('keeps the inactive Codex debounce across an account switch instead of re-probing', async () => {
    const service = new RateLimitService()
    service.setInactiveCodexAccountsResolver(() => [
      inactiveCodexAccount('account-b', '/tmp/account-b/home')
    ])
    vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 10))

    await service.fetchInactiveCodexAccountsOnOpen()
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

    await service.refreshForCodexAccountChange('account-a')
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)

    // Reopening inside debounce must not spawn Codex again in each live credential home.
    await service.fetchInactiveCodexAccountsOnOpen()
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('staggers inactive Codex probes instead of bursting every account at once', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setInactiveCodexAccountsResolver(() => [
        inactiveCodexAccount('account-a', '/tmp/account-a/home'),
        inactiveCodexAccount('account-b', '/tmp/account-b/home')
      ])
      vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 5))

      const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
      await fetchOnOpen
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start another inactive Codex batch during the inter-account stagger', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setInactiveCodexAccountsResolver(() => [
        inactiveCodexAccount('account-a', '/tmp/account-a/home'),
        inactiveCodexAccount('account-b', '/tmp/account-b/home')
      ])
      vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 5))

      const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
      expect(service.getState().inactiveCodexAccounts).toEqual([
        expect.objectContaining({ accountId: 'account-a', isFetching: false })
      ])

      await service.fetchInactiveCodexAccountsOnOpen()
      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(2_000)
      await fetchOnOpen
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recache an inactive Claude account removed during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [{ id: 'account-1' }]
    service.setInactiveClaudeAccountsResolver(() => inactiveAccounts)
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
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
    inactiveAccounts = [{ id: 'account-1' }]
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
    service.setInactiveClaudeAccountsResolver(() => [{ id: 'account-1' }])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
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

  it('reads the selected account from the same poll when no live session is open', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const service = new RateLimitService()
      service.setInactiveClaudeAccountsResolver(() => [{ id: 'idle' }])
      service.setActiveClaudeUsageAccountResolver(() => ({ id: 'active' }))
      vi.mocked(fetchManagedAccountUsage).mockImplementation(async (account) =>
        claudePollReading(account.id === 'active' ? 11 : 22, account.id === 'active' ? 3 : 4, {
          authProvenance: `profile:${account.id}`,
          source: 'oauth'
        })
      )

      await service.fetchInactiveClaudeAccountsOnOpen()

      expect(vi.mocked(fetchManagedAccountUsage).mock.calls.map((call) => call[0].id)).toEqual([
        'idle',
        'active'
      ])
      const state = service.getState()
      expect(state.claude).toEqual(
        expect.objectContaining({
          status: 'ok',
          usageMetadata: expect.objectContaining({ authProvenance: 'profile:active' })
        })
      )
      expect(state.claude?.weekly?.usedPercent).toBe(11)
      expect(state.claude?.fableWeekly?.usedPercent).toBe(3)
      expect(state.inactiveClaudeAccounts.map((row) => row.accountId)).toEqual(['idle'])
      expect(state.inactiveClaudeAccounts[0]?.rateLimits?.weekly?.usedPercent).toBe(22)
      expect(state.inactiveClaudeAccounts[0]?.rateLimits?.fableWeekly?.usedPercent).toBe(4)

      info.mockClear()
      await service.fetchInactiveClaudeAccountsOnOpen()
      expect(info).toHaveBeenCalledWith('[claude-usage] inactive fetch skipped reason=debounce')
      expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(2)
    } finally {
      info.mockRestore()
    }
  })

  it('does not overwrite a fresh live session or a usage reading from the same poll cycle', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const live = new SeededRateLimits()
      live.setInactiveClaudeAccountsResolver(() => [{ id: 'idle' }])
      live.setActiveClaudeUsageAccountResolver(() => ({ id: 'active' }))
      live.seedClaude(
        claudePollReading(40, 7, { source: 'live-session', authProvenance: 'profile:active' }),
        null
      )
      vi.mocked(fetchManagedAccountUsage).mockImplementation(async (account) =>
        claudePollReading(99, 99, { authProvenance: `profile:${account.id}`, source: 'oauth' })
      )

      await live.fetchInactiveClaudeAccountsOnOpen()

      expect(vi.mocked(fetchManagedAccountUsage).mock.calls.map((call) => call[0].id)).toEqual([
        'idle'
      ])
      expect(live.getState().claude?.weekly?.usedPercent).toBe(40)
      expect(info.mock.calls.map((call) => String(call[0]))).toContain(
        '[claude-usage] inactive fetch skipped reason=live-session account=active'
      )

      const sameCycle = new SeededRateLimits()
      sameCycle.setInactiveClaudeAccountsResolver(() => [{ id: 'idle' }])
      sameCycle.setActiveClaudeUsageAccountResolver(() => ({ id: 'active' }))
      sameCycle.seedClaude(
        claudePollReading(15, 2, { source: 'oauth', authProvenance: 'profile:active' }),
        Date.now()
      )
      vi.mocked(fetchManagedAccountUsage).mockClear()
      info.mockClear()

      await sameCycle.fetchInactiveClaudeAccountsOnOpen()

      expect(vi.mocked(fetchManagedAccountUsage).mock.calls.map((call) => call[0].id)).toEqual([
        'idle'
      ])
      expect(sameCycle.getState().claude?.weekly?.usedPercent).toBe(15)
      expect(info.mock.calls.map((call) => String(call[0]))).toContain(
        '[claude-usage] inactive fetch skipped reason=already-read account=active'
      )

      const systemDefault = new SeededRateLimits()
      systemDefault.setActiveClaudeUsageAccountResolver(() => ({
        id: 'active',
        runsOnSystemDefault: true
      }))
      systemDefault.seedClaude(
        claudePollReading(8, 1, { source: 'oauth', authProvenance: 'system' }),
        Date.now()
      )
      vi.mocked(fetchManagedAccountUsage).mockClear()

      await systemDefault.fetchInactiveClaudeAccountsOnOpen()

      expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
      expect(systemDefault.getState().claude?.weekly?.usedPercent).toBe(8)
    } finally {
      info.mockRestore()
    }
  })

  it('replaces a stale live session reading and logs when nothing is attached', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const bare = new RateLimitService()
      await bare.fetchInactiveClaudeAccountsOnOpen()
      bare.setInactiveClaudeAccountsResolver(() => [])
      await bare.fetchInactiveClaudeAccountsOnOpen()
      const lines = info.mock.calls.map((call) => String(call[0]))
      expect(lines).toContain('[claude-usage] inactive fetch skipped reason=not-attached')
      expect(lines).toContain('[claude-usage] inactive fetch skipped reason=no-accounts')
      expect(lines).toContain('[claude-usage] inactive fetch start n=0')
      expect(lines).toContain('[claude-usage] inactive fetch done n=0 ok=0 failed=0')

      const service = new SeededRateLimits()
      service.setActiveClaudeUsageAccountResolver(() => ({ id: 'active' }))
      const stale = claudePollReading(40, 7, {
        source: 'live-session',
        authProvenance: 'profile:active'
      })
      stale.updatedAt = Date.now() - MIN_REFETCH_MS - 1
      service.seedClaude(stale, null)
      vi.mocked(fetchManagedAccountUsage).mockResolvedValue(
        claudePollReading(12, 5, { authProvenance: 'profile:active', source: 'oauth' })
      )

      await service.fetchInactiveClaudeAccountsOnOpen()

      expect(vi.mocked(fetchManagedAccountUsage).mock.calls.map((call) => call[0].id)).toEqual([
        'active'
      ])
      expect(service.getState().claude?.weekly?.usedPercent).toBe(12)
      expect(service.getState().inactiveClaudeAccounts).toEqual([])
    } finally {
      info.mockRestore()
    }
  })
})

function claudePollReading(
  weekly: number,
  fable: number,
  usageMetadata: ProviderRateLimits['usageMetadata']
): ProviderRateLimits {
  const pane = (usedPercent: number) => ({
    usedPercent,
    windowMinutes: 10080,
    resetsAt: null,
    resetDescription: null
  })
  return {
    provider: 'claude',
    session: pane(weekly),
    weekly: pane(weekly),
    fableWeekly: pane(fable),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata
  }
}

class SeededRateLimits extends RateLimitService {
  seedClaude(limits: ProviderRateLimits, checkedAt: number | null): void {
    this.lastClaudeCheckCompletedAt = checkedAt
    this.updateState({ ...this.state, claude: limits })
  }
}
