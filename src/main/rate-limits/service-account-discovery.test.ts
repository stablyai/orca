import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import { fetchMiniMaxRateLimits } from './minimax/minimax-fetcher'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { readCursorAuthSession } from './cursor-auth'
import { readGrokAuthSession } from './grok-auth'
import {
  deferred,
  flushMicrotasks,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from './service/service-types'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn()
}))
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: vi.fn(() => false) }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: vi.fn(() => false) }))

function disabledService(connected: ProviderRateLimits['provider'][] = []) {
  const service = new RateLimitService()
  service.setAccountDiscoveryPolicyResolver(() => ({
    automaticallyDetect: false,
    isConnected: (provider) => connected.includes(provider)
  }))
  return service
}

beforeEach(() => {
  resetRateLimitProviderMocks()
  vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10))
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
})

describe('account discovery opt-out', () => {
  it('rejects an aborted cycle even while discovery is enabled', async () => {
    class AdmissionService extends RateLimitService {
      fetchGemini(signal: AbortSignal, fetch: () => Promise<ProviderRateLimits>) {
        return this.fetchAllowedProvider('gemini', signal, fetch)
      }

      resolveClaude(signal: AbortSignal) {
        return this.resolveClaudeAuthForUsage({ runtime: 'host' }, signal)
      }
    }
    const service = new AdmissionService()
    const auth = vi.fn()
    const fetch = vi.fn(async () => okProvider('gemini', 10))
    service.setClaudeAuthPreparationResolver(auth)
    const controller = new AbortController()
    controller.abort()
    expect(await service.fetchGemini(controller.signal, fetch)).toMatchObject({
      provider: 'gemini',
      status: 'unavailable'
    })
    expect(service.resolveClaude(controller.signal)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(auth).not.toHaveBeenCalled()
  })

  it('never probes ambient credentials or usage, including direct host and WSL refreshes', async () => {
    const service = disabledService()
    const claudeAuth = vi.fn()
    const codexHome = vi.fn()
    const kimiHome = vi.fn()
    const opencodeKey = vi.fn()
    const minimax = vi.fn()
    const zcode = vi.fn()
    service.setClaudeAuthPreparationResolver(claudeAuth)
    service.setCodexHomePathResolver(codexHome)
    service.setKimiHomeResolver(kimiHome)
    service.setOpenCodeGoConfigResolver(
      () => ({ sessionCookie: '', workspaceIdOverride: '' }),
      opencodeKey
    )
    service.setMiniMaxConfigResolver(minimax)
    service.setZcodePlanConfigResolver(zcode)
    await service.refresh()
    await service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await service.refreshClaudeForTarget({ runtime: 'host' })
    await service.refreshCodexForTarget({ runtime: 'host' })
    await service.refreshGrok()
    for (const probe of [
      claudeAuth,
      codexHome,
      kimiHome,
      opencodeKey,
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
      fetchZcodeRateLimits,
      fetchGrokRateLimits,
      fetchCursorRateLimits,
      fetchAntigravityRateLimits
    ]) {
      expect(probe).not.toHaveBeenCalled()
    }
    expect(service.getState().claude).toBeNull()
    expect(service.getState().codex).toBeNull()
  })

  it('keeps explicit providers, with ambient OpenCode key discovery disabled', async () => {
    const service = disabledService([
      'claude',
      'codex',
      'gemini',
      'opencode-go',
      'minimax',
      'zcode',
      'antigravity'
    ])
    const claudeAuth = vi.fn(async () => ({
      configDir: '/managed/claude',
      runtime: 'host' as const,
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'managed:saved:host'
    }))
    const codexHome = vi.fn(() => ({ kind: 'ready' as const, codexHomePath: '/managed/codex' }))
    service.setClaudeAuthPreparationResolver(claudeAuth)
    service.setCodexHomePathResolver(codexHome)
    service.setGeminiCliOAuthEnabledResolver(() => true)
    await service.refresh()
    expect(claudeAuth).toHaveBeenCalled()
    expect(fetchClaudeRateLimits).toHaveBeenCalledOnce()
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: '/managed/codex' })
    )
    expect(fetchGeminiRateLimits).toHaveBeenCalledWith(true)
    expect(fetchOpenCodeGoUsage).toHaveBeenCalledWith(
      expect.objectContaining({ allowAmbientCredentials: false })
    )
    expect(fetchMiniMaxRateLimits).toHaveBeenCalledOnce()
    expect(fetchZcodeRateLimits).toHaveBeenCalledOnce()
    expect(fetchAntigravityRateLimits).toHaveBeenCalledOnce()
    expect(readCursorAuthSession).not.toHaveBeenCalled()
    expect(readGrokAuthSession).not.toHaveBeenCalled()
  })

  it('gates direct refresh by target before resolving a managed WSL home', async () => {
    const service = new RateLimitService()
    service.setAccountDiscoveryPolicyResolver(() => ({
      automaticallyDetect: false,
      isConnected: (provider, target) =>
        provider === 'codex' && target?.runtime === 'wsl' && target.wslDistro === 'Ubuntu'
    }))
    const home = vi.fn(() => ({ kind: 'ready' as const, codexHomePath: '/wsl/managed' }))
    service.setCodexHomePathResolver(home)
    await service.refreshCodexForTarget({ runtime: 'host' })
    expect(home).not.toHaveBeenCalled()
    await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(home).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: '/wsl/managed' })
    )
    await service.refreshCodexForTarget({ runtime: 'wsl', wslDistro: 'Debian' })
    expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
    expect(service.getState().codex).toBeNull()
  })

  it('drops an in-flight ambient result and clears snapshots, then resumes on re-enable', async () => {
    const service = new RateLimitService()
    let automaticallyDetect = true
    service.setAccountDiscoveryPolicyResolver(() => ({
      automaticallyDetect,
      isConnected: () => false
    }))
    await service.refresh()
    expect(service.getState().claude?.status).toBe('ok')
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchClaudeRateLimits).mockReturnValueOnce(pending.promise)
    const refresh = service.refresh()
    await flushMicrotasks()
    automaticallyDetect = false
    service.accountDiscoveryPolicyChanged()
    expect(service.getState().claude).toBeNull()
    expect(service.getState().kimi).toBeNull()
    pending.resolve(okProvider('claude', 99))
    await refresh
    expect(service.getState().claude).toBeNull()
    automaticallyDetect = true
    service.accountDiscoveryPolicyChanged()
    await service.refresh()
    expect(service.getState().claude?.session?.usedPercent).toBe(10)
  })

  it.each(['full', 'direct'] as const)(
    'does not revive an aborted %s cycle after Claude auth resolves',
    async (cycle) => {
      const service = new RateLimitService()
      let automaticallyDetect = true
      service.setAccountDiscoveryPolicyResolver(() => ({
        automaticallyDetect,
        isConnected: () => false
      }))
      const pending = deferred<ClaudeRuntimeAuthPreparation>()
      const auth = vi.fn(() => pending.promise)
      service.setClaudeAuthPreparationResolver(auth)
      const refresh =
        cycle === 'full'
          ? service.refresh()
          : service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      await flushMicrotasks()
      expect(auth).toHaveBeenCalledOnce()
      automaticallyDetect = false
      service.accountDiscoveryPolicyChanged()
      automaticallyDetect = true
      service.accountDiscoveryPolicyChanged()
      pending.resolve({
        configDir: '/managed/claude',
        envPatch: {},
        stripAuthEnv: false,
        provenance: 'managed'
      })
      await refresh
      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
      expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    }
  )

  it.each(['full', 'direct'] as const)(
    'rechecks Claude eligibility after auth resolves in a %s cycle',
    async (cycle) => {
      const service = new RateLimitService()
      let automaticallyDetect = true
      service.setAccountDiscoveryPolicyResolver(() => ({
        automaticallyDetect,
        isConnected: (provider) => provider === 'codex'
      }))
      const pending = deferred<ClaudeRuntimeAuthPreparation>()
      service.setClaudeAuthPreparationResolver(() => pending.promise)
      const refresh =
        cycle === 'full'
          ? service.refresh()
          : service.refreshClaudeForTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      await flushMicrotasks()
      automaticallyDetect = false
      pending.resolve({
        configDir: '/managed/claude',
        envPatch: {},
        stripAuthEnv: false,
        provenance: 'managed'
      })
      await refresh
      expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
      if (cycle === 'full') {
        expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
        expect(service.getState().codex?.status).toBe('ok')
      }
    }
  )

  it.each(['policy-only', 'abort', 'abort-and-re-enable'] as const)(
    'does not start the Cursor fetch when disabled during its keychain read (%s)',
    async (change) => {
      const service = new RateLimitService()
      let automaticallyDetect = true
      service.setAccountDiscoveryPolicyResolver(() => ({
        automaticallyDetect,
        isConnected: () => false
      }))
      const pending = deferred<Awaited<ReturnType<typeof readCursorAuthSession>>>()
      vi.mocked(readCursorAuthSession).mockReturnValueOnce(pending.promise)
      const refresh = service.refresh()
      await flushMicrotasks()
      automaticallyDetect = false
      if (change !== 'policy-only') {
        service.accountDiscoveryPolicyChanged()
      }
      if (change === 'abort-and-re-enable') {
        automaticallyDetect = true
        service.accountDiscoveryPolicyChanged()
      }
      pending.resolve({ status: 'missing' })
      await refresh
      expect(fetchCursorRateLimits).not.toHaveBeenCalled()
      expect(service.getState().cursorAuthConfigured).toBe(false)
    }
  )

  it.each(['policy-only', 'abort', 'abort-and-re-enable'] as const)(
    'does not read Kimi credentials after a pending WSL home resolves (%s)',
    async (change) => {
      const service = new RateLimitService()
      let automaticallyDetect = true
      service.setAccountDiscoveryPolicyResolver(() => ({
        automaticallyDetect,
        isConnected: () => false
      }))
      const pending = deferred<{
        runtime: 'wsl'
        wslDistro: string
        path: string
      }>()
      const home = vi.fn(() => pending.promise)
      service.setKimiHomeResolver(home)
      const refresh = service.refresh()
      await flushMicrotasks()
      expect(home).toHaveBeenCalledOnce()
      automaticallyDetect = false
      if (change !== 'policy-only') {
        service.accountDiscoveryPolicyChanged()
      }
      if (change === 'abort-and-re-enable') {
        automaticallyDetect = true
        service.accountDiscoveryPolicyChanged()
      }
      pending.resolve({ runtime: 'wsl', wslDistro: 'Ubuntu', path: '/wsl/kimi' })
      await refresh
      expect(fetchKimiRateLimits).not.toHaveBeenCalled()
      if (change === 'abort') {
        expect(service.getState().kimi).toBeNull()
      }
    }
  )

  it('fetches Kimi with the resolved WSL home when discovery remains enabled', async () => {
    const service = new RateLimitService()
    const pending = deferred<{ runtime: 'wsl'; wslDistro: string; path: string }>()
    service.setKimiHomeResolver(() => pending.promise)
    const refresh = service.refresh()
    await flushMicrotasks()
    expect(fetchKimiRateLimits).not.toHaveBeenCalled()
    const home = { runtime: 'wsl' as const, wslDistro: 'Ubuntu', path: '/wsl/kimi' }
    pending.resolve(home)
    await refresh
    expect(fetchKimiRateLimits).toHaveBeenCalledExactlyOnceWith({ home })
  })

  it('drops ambient live usage while preserving explicitly connected live usage', async () => {
    const service = new RateLimitService()
    let connected = true
    service.setAccountDiscoveryPolicyResolver(() => ({
      automaticallyDetect: false,
      isConnected: (provider) => provider === 'claude' && connected
    }))
    await service.refresh()
    service.ingestLiveClaudeRateLimits({
      configDir: null,
      fiveHour: { used_percentage: 55 },
      sevenDay: null
    })
    expect(service.getState().claude?.session?.usedPercent).toBe(55)
    connected = false
    service.accountDiscoveryPolicyChanged()
    service.ingestLiveClaudeRateLimits({
      configDir: null,
      fiveHour: { used_percentage: 99 },
      sevenDay: null
    })
    expect(service.getState().claude).toBeNull()
  })

  it('keeps inactive managed account previews available', async () => {
    const service = disabledService()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'saved', managedAuthPath: '/managed/claude' }
    ])
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 42))
    await service.fetchInactiveClaudeAccountsOnOpen()
    expect(fetchManagedAccountUsage).toHaveBeenCalled()
    expect(service.getState().inactiveClaudeAccounts?.[0]?.rateLimits?.session?.usedPercent).toBe(
      42
    )
    service.setInactiveCodexAccountsResolver(() => [
      {
        id: 'codex-saved',
        resolveHome: () => ({ kind: 'ready' as const, managedHomePath: '/managed/codex' })
      }
    ])
    await service.fetchInactiveCodexAccountsOnOpen()
    expect(fetchCodexRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({ codexHomePath: '/managed/codex' })
    )
    expect(service.getState().inactiveCodexAccounts?.[0]?.rateLimits?.session?.usedPercent).toBe(20)
  })
})
