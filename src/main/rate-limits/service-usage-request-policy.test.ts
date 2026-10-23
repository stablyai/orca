import { beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchManagedAccountUsage, fetchClaudeRateLimits } from './claude-fetcher'
import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax/minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import {
  deferred,
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

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { readCursorAuthSession } from './cursor-auth'

const enabled = (value = true): Record<ProviderRateLimits['provider'], boolean> => ({
  claude: value,
  codex: value,
  gemini: value,
  'opencode-go': value,
  kimi: value,
  minimax: value,
  grok: value,
  antigravity: value,
  cursor: value,
  zcode: value
})

beforeEach(() => {
  resetRateLimitProviderMocks()
  mockFreshBackgroundProviderFetches()
  vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 12))
})

it('blocks all ten providers before credential preparation on forced and account refreshes', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => enabled(false))
  const claudeAuth = vi.fn()
  const codexHome = vi.fn()
  const kimiHome = vi.fn()
  const openCode = vi.fn()
  const minimax = vi.fn()
  const zcode = vi.fn()
  service.setClaudeAuthPreparationResolver(claudeAuth)
  service.setCodexHomePathResolver(codexHome)
  service.setKimiHomeResolver(kimiHome)
  service.setOpenCodeGoConfigResolver(openCode)
  service.setMiniMaxConfigResolver(minimax)
  service.setZcodePlanConfigResolver(zcode)
  vi.mocked(readGrokAuthSession).mockClear()
  await service.refresh()
  await service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'stopped' })
  await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'stopped' })
  await service.refreshGrok()
  for (const operation of [
    claudeAuth,
    codexHome,
    kimiHome,
    openCode,
    minimax,
    zcode,
    readGrokAuthSession,
    readCursorAuthSession,
    fetchClaudeRateLimits,
    fetchCodexRateLimits,
    fetchGeminiRateLimits,
    fetchKimiRateLimits,
    fetchOpenCodeGoUsage,
    fetchMiniMaxRateLimits,
    fetchGrokRateLimits,
    fetchCursorRateLimits,
    fetchZcodeRateLimits,
    fetchAntigravityRateLimits
  ]) {
    expect(operation).not.toHaveBeenCalled()
  }
  const state = service.getState()
  expect(state.usageRequestPolicy?.enabled).toEqual(enabled(false))
  expect(state.claudeTarget).toEqual({ runtime: 'wsl', wslDistro: 'stopped' })
  expect(state.claude?.status).not.toBe('fetching')
  expect(state.codex?.status).not.toBe('fetching')
})

it('blocks inactive usage and post-reset reads while preserving the explicit reset mutation', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => enabled(false))
  const home = vi.fn(() => ({ kind: 'ready' as const, managedHomePath: '/saved' }))
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'saved' }])
  service.setInactiveCodexAccountsResolver(() => [{ id: 'saved', resolveHome: home }])
  vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValue('noCredit')
  await service.fetchInactiveClaudeAccountsOnOpen()
  await service.fetchInactiveCodexAccountsOnOpen()
  const result = await service.consumeCodexRateLimitResetCredit({
    idempotencyKey: 'test',
    target: { runtime: 'host', wslDistro: null },
    codexHomePath: '/saved'
  })
  expect(result.outcome).toBe('noCredit')
  expect(consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1)
  expect(home).not.toHaveBeenCalled()
  expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
  expect(fetchCodexRateLimits).not.toHaveBeenCalled()
})

it('cancels only the disabled provider and rejects its late result after reenabling', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  const old = deferred<ProviderRateLimits>()
  const started = deferred<void>()
  let claudeSignal: AbortSignal | undefined
  let codexSignal: AbortSignal | undefined
  vi.mocked(fetchClaudeRateLimits).mockImplementationOnce((options) => {
    claudeSignal = options?.signal
    started.resolve()
    return old.promise
  })
  vi.mocked(fetchCodexRateLimits).mockImplementationOnce(async (options) => {
    codexSignal = options?.signal
    return okProvider('codex', 32)
  })
  const pending = service.refresh()
  await started.promise
  policy = { ...policy, claude: false }
  service.reconcileUsageRequestPolicy()
  expect(claudeSignal?.aborted).toBe(true)
  expect(codexSignal?.aborted).toBe(false)
  policy = { ...policy, claude: true }
  service.reconcileUsageRequestPolicy()
  old.resolve(okProvider('claude', 99))
  await pending
  expect(service.getState().claude?.session?.usedPercent).not.toBe(99)
  expect(service.getState().codex?.session?.usedPercent).toBe(32)
  await service.refresh()
  expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
})

it('discards a structured Cursor cancellation result after disabling and reenabling', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  vi.mocked(fetchCursorRateLimits).mockResolvedValue(okProvider('cursor', 42))
  await service.refresh()
  const cached = service.getState().cursor
  const cancelled = deferred<ProviderRateLimits>()
  const started = deferred<void>()
  let signal: AbortSignal | undefined
  vi.mocked(fetchCursorRateLimits).mockImplementationOnce((options) => {
    signal = options?.signal
    started.resolve()
    return cancelled.promise
  })
  const pending = service.refresh()
  await started.promise
  policy = { ...policy, cursor: false }
  service.reconcileUsageRequestPolicy()
  expect(signal?.aborted).toBe(true)
  policy = { ...policy, cursor: true }
  service.reconcileUsageRequestPolicy()
  cancelled.resolve({
    provider: 'cursor',
    status: 'error',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Cursor usage request failed',
    usageMetadata: { failureKind: 'network' }
  })
  await pending
  expect(service.getState().cursor).toEqual(cached)
})

it('keeps live Claude attribution independent of disabled usage preparation at startup and retarget', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => enabled(false))
  const auth = vi.fn()
  const attribution = vi.fn(async () => ({
    configDir: '/selected',
    envPatch: { CLAUDE_CONFIG_DIR: '/selected' },
    provenance: 'profile:new'
  }))
  service.setClaudeAuthPreparationResolver(auth)
  service.setClaudeUsageAttributionResolver(attribution)
  await service.refreshClaudeUsageAttribution()
  service.ingestLiveClaudeRateLimits({
    configDir: '/selected',
    fiveHour: { used_percentage: 23 },
    sevenDay: null
  })
  expect(service.getState().claude?.session?.usedPercent).toBe(23)
  expect(service.getState().claude?.usageMetadata?.source).toBe('live-session')
  expect(auth).not.toHaveBeenCalled()
  expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
})

it('does not admit a queued Claude refresh or resume its endpoint after disabling during preparation', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  const preparation = deferred<{
    configDir: string
    envPatch: Record<string, string>
    provenance: string
  }>()
  const started = deferred<void>()
  const auth = vi.fn(() => {
    started.resolve()
    return preparation.promise
  })
  service.setClaudeAuthPreparationResolver(auth)
  const refresh = service.refresh()
  await started.promise
  const queued = service.refreshClaudeForTarget()
  policy = { ...policy, claude: false }
  service.reconcileUsageRequestPolicy()
  preparation.resolve({
    configDir: '/old',
    envPatch: { CLAUDE_CONFIG_DIR: '/old' },
    provenance: 'old'
  })
  await Promise.all([refresh, queued])
  expect(auth).toHaveBeenCalledTimes(1)
  expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
  expect(service.getState().codex?.status).toBe('ok')
  expect(service.getState().claude?.status).not.toBe('fetching')
})

it('cancels inactive account loops without admitting the next account or publishing late usage', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'one' }, { id: 'two' }])
  const pending = deferred<ProviderRateLimits>()
  const started = deferred<void>()
  let signal: AbortSignal | undefined
  vi.mocked(fetchManagedAccountUsage).mockImplementationOnce((_account, options) => {
    signal = options?.signal
    started.resolve()
    return pending.promise
  })
  const refresh = service.fetchInactiveClaudeAccountsOnOpen()
  await started.promise
  policy = { ...policy, claude: false }
  service.reconcileUsageRequestPolicy()
  expect(signal?.aborted).toBe(true)
  expect(service.getState().inactiveClaudeAccounts.some((account) => account.isFetching)).toBe(
    false
  )
  policy = { ...policy, claude: true }
  service.reconcileUsageRequestPolicy()
  pending.resolve(okProvider('claude', 91))
  await refresh
  expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(1)
  expect(service.getState().inactiveClaudeAccounts).toEqual([])
})

it('does not let disabled empty snapshots trigger fresh enabled siblings through stale refresh', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => ({ ...enabled(false), codex: true }))
  await service.refresh()
  await service.refreshIfStale()
  await service.refreshIfStale()
  expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  service.invalidateMiniMaxCredentialState()
  service.invalidateOpenCodeGoCredentialState()
  service.invalidateZcodeCredentialState()
  await service.refreshIfStale()
  expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
  expect(service.getState().minimax?.status).not.toBe('fetching')
  expect(service.getState().opencodeGo?.status).not.toBe('fetching')
  expect(service.getState().zcode?.status).not.toBe('fetching')
})

it('fences a delayed read-only attribution when the account target changes', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => enabled(false))
  const first = deferred<{
    configDir: string
    envPatch: Record<string, string>
    provenance: string
  }>()
  service.setClaudeUsageAttributionResolver(
    vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({
        configDir: '/new',
        envPatch: { CLAUDE_CONFIG_DIR: '/new' },
        provenance: 'new'
      })
  )
  const oldAttribution = service.refreshClaudeUsageAttribution()
  await service.refreshForClaudeAccountChange('old')
  first.resolve({ configDir: '/old', envPatch: { CLAUDE_CONFIG_DIR: '/old' }, provenance: 'old' })
  await oldAttribution
  service.ingestLiveClaudeRateLimits({
    configDir: '/old',
    fiveHour: { used_percentage: 99 },
    sevenDay: null
  })
  expect(service.getState().claude?.session).toBeNull()
  service.ingestLiveClaudeRateLimits({
    configDir: '/new',
    fiveHour: { used_percentage: 13 },
    sevenDay: null
  })
  expect(service.getState().claude?.session?.usedPercent).toBe(13)
  expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
})

it('keeps disabled live Claude data posted while another provider is preparing', async () => {
  const service = new RateLimitService()
  service.setUsageRequestPolicyResolver(() => ({ ...enabled(false), codex: true }))
  service.setClaudeUsageAttributionResolver(async () => ({
    configDir: '/live',
    envPatch: { CLAUDE_CONFIG_DIR: '/live' },
    provenance: 'live'
  }))
  await service.refreshClaudeUsageAttribution()
  const home = deferred<{ kind: 'ready'; codexHomePath: string }>()
  const started = deferred<void>()
  service.setCodexHomePathResolver(
    vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve()
        return home.promise
      })
      .mockResolvedValue({ kind: 'ready', codexHomePath: '/codex' })
  )
  const refresh = service.refresh()
  await started.promise
  service.ingestLiveClaudeRateLimits({
    configDir: '/live',
    fiveHour: { used_percentage: 37 },
    sevenDay: null
  })
  home.resolve({ kind: 'ready', codexHomePath: '/codex' })
  await refresh
  expect(service.getState().claude?.session?.usedPercent).toBe(37)
  expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
})

it.each(['claude', 'codex'] as const)(
  'keeps cached inactive %s readings when a disabled old request rejects',
  async (provider) => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      let policy = enabled()
      service.setUsageRequestPolicyResolver(() => policy)
      service.setInactiveClaudeAccountsResolver(() => [{ id: 'saved' }])
      service.setInactiveCodexAccountsResolver(() => [
        { id: 'saved', resolveHome: () => ({ kind: 'ready', managedHomePath: '/saved' }) }
      ])
      const snapshot = okProvider(provider, 41)
      vi.mocked(fetchManagedAccountUsage).mockResolvedValue(snapshot)
      vi.mocked(fetchCodexRateLimits).mockResolvedValue(snapshot)
      const refresh = () =>
        provider === 'claude'
          ? service.fetchInactiveClaudeAccountsOnOpen()
          : service.fetchInactiveCodexAccountsOnOpen()
      const cached = () =>
        provider === 'claude'
          ? service.getState().inactiveClaudeAccounts
          : service.getState().inactiveCodexAccounts
      await refresh()
      expect(cached()[0]?.rateLimits?.session?.usedPercent).toBe(41)
      await vi.advanceTimersByTimeAsync(60_001)
      let rejectPending: (reason: unknown) => void = () => {}
      const pending = new Promise<ProviderRateLimits>((_resolve, reject) => {
        rejectPending = reject
      })
      if (provider === 'claude') {
        vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(pending)
      } else {
        vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(pending)
      }
      const oldRefresh = refresh()
      policy = { ...policy, [provider]: false }
      service.reconcileUsageRequestPolicy()
      policy = { ...policy, [provider]: true }
      service.reconcileUsageRequestPolicy()
      rejectPending(new Error('cancelled old request'))
      await oldRefresh
      expect(cached()[0]?.rateLimits?.session?.usedPercent).toBe(41)
      expect(cached()[0]?.updatedAt).toBe(snapshot.updatedAt)
      expect(cached()[0]?.isFetching).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  }
)

it('does not let an older cancelled Claude loop clear a reenabled loop spinner or cache', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'saved' }])
  let rejectOld: (reason: unknown) => void = () => {}
  const old = new Promise<ProviderRateLimits>((_resolve, reject) => {
    rejectOld = reject
  })
  const current = deferred<ProviderRateLimits>()
  vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(old).mockReturnValueOnce(current.promise)
  const oldRefresh = service.fetchInactiveClaudeAccountsOnOpen()
  policy = { ...policy, claude: false }
  service.reconcileUsageRequestPolicy()
  policy = { ...policy, claude: true }
  service.reconcileUsageRequestPolicy()
  const currentRefresh = service.fetchInactiveClaudeAccountsOnOpen()
  expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(2)
  expect(service.getState().inactiveClaudeAccounts[0]?.isFetching).toBe(true)
  rejectOld(new Error('cancelled'))
  await oldRefresh
  expect(service.getState().inactiveClaudeAccounts[0]?.isFetching).toBe(true)
  current.resolve(okProvider('claude', 28))
  await currentRefresh
  expect(service.getState().inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(28)
  expect(service.getState().inactiveClaudeAccounts[0]?.isFetching).toBe(false)
})

it('does not resume old secret preparation after disabling and reenabling during another provider await', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  const home = deferred<{ kind: 'ready'; codexHomePath: string }>()
  const started = deferred<void>()
  service.setCodexHomePathResolver(() => {
    started.resolve()
    return home.promise
  })
  const openCode = vi.fn(() => ({ sessionCookie: '', workspaceIdOverride: '' }))
  const minimax = vi.fn(() => ({
    sessionCookie: '',
    groupId: '',
    models: 'general',
    endpoint: 'overseas' as const,
    apiKey: ''
  }))
  const zcode = vi.fn(() => ({ site: 'zai' as const, apiKey: '' }))
  service.setOpenCodeGoConfigResolver(openCode)
  service.setMiniMaxConfigResolver(minimax)
  service.setZcodePlanConfigResolver(zcode)
  const refresh = service.refresh()
  await started.promise
  policy = { ...policy, 'opencode-go': false, minimax: false, zcode: false }
  service.reconcileUsageRequestPolicy()
  policy = enabled()
  service.reconcileUsageRequestPolicy()
  home.resolve({ kind: 'ready', codexHomePath: '/codex' })
  await refresh
  expect(openCode).not.toHaveBeenCalled()
  expect(minimax).not.toHaveBeenCalled()
  expect(zcode).not.toHaveBeenCalled()
  expect(fetchOpenCodeGoUsage).not.toHaveBeenCalled()
  expect(fetchMiniMaxRateLimits).not.toHaveBeenCalled()
  expect(fetchZcodeRateLimits).not.toHaveBeenCalled()
})

it('rejects a reset quota result disabled during its final target check and returns current policy', async () => {
  const service = new RateLimitService()
  let policy = enabled()
  service.setUsageRequestPolicyResolver(() => policy)
  const home = deferred<{ kind: 'ready'; codexHomePath: string }>()
  const started = deferred<void>()
  service.setCodexHomePathResolver(() => {
    started.resolve()
    return home.promise
  })
  vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValue('noCredit')
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 77))
  const reset = service.consumeCodexRateLimitResetCredit({
    idempotencyKey: 'final-check',
    target: { runtime: 'host', wslDistro: null },
    codexHomePath: '/codex'
  })
  await started.promise
  policy = { ...policy, codex: false }
  service.reconcileUsageRequestPolicy()
  home.resolve({ kind: 'ready', codexHomePath: '/codex' })
  const result = await reset
  expect(result.state.codex?.session?.usedPercent).not.toBe(77)
  expect(service.getState().codex?.session?.usedPercent).not.toBe(77)
  expect(result.state.usageRequestPolicy).toEqual(service.getState().usageRequestPolicy)
})
