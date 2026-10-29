import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { readGrokAuthSession } from './grok-auth'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import { fetchMiniMaxRateLimits } from './minimax/minimax-fetcher'
import {
  deferred,
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

describe('Grok async preparation', () => {
  const services: RateLimitService[] = []
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(readGrokAuthSession).mockResolvedValue({ status: 'missing' })
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 11))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 81))
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 71))
    vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(okProvider('minimax', 61))
  })
  afterEach(() => services.splice(0).forEach((service) => service.stop()))

  function service() {
    const instance = new RateLimitService()
    services.push(instance)
    return instance
  }

  it('preserves an account switch and credential invalidation during Grok-only auth', async () => {
    const instance = service()
    await instance.refresh()
    const auth = deferred<Awaited<ReturnType<typeof readGrokAuthSession>>>()
    vi.mocked(readGrokAuthSession).mockReturnValueOnce(auth.promise)
    const refresh = instance.refreshGrok()
    await vi.waitFor(() => expect(readGrokAuthSession).toHaveBeenCalledTimes(2))
    instance.invalidateOpenCodeGoCredentialState()
    instance.invalidateMiniMaxCredentialState()
    const codex = deferred<Awaited<ReturnType<typeof fetchCodexRateLimits>>>()
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(codex.promise)
    const switchAccount = instance.refreshForCodexAccountChange('outgoing', { runtime: 'host' })
    auth.resolve({ status: 'missing' })
    await vi.waitFor(() => expect(fetchGrokRateLimits).toHaveBeenCalledTimes(2))
    expect(instance.getState().codex?.session).toBeNull()
    expect(instance.getState().opencodeGo?.session).toBeNull()
    expect(instance.getState().minimax?.session).toBeNull()
    codex.resolve(okProvider('codex', 9))
    await Promise.all([refresh, switchAccount])
    expect(instance.getState().codex?.session?.usedPercent).toBe(9)
  })

  it.each(['grok', 'full'])(
    'does not publish or fetch Grok after stop during %s auth',
    async (cycle) => {
      const instance = service()
      const auth = deferred<Awaited<ReturnType<typeof readGrokAuthSession>>>()
      vi.mocked(readGrokAuthSession).mockReturnValueOnce(auth.promise)
      const refresh = cycle === 'grok' ? instance.refreshGrok() : instance.refresh()
      await vi.waitFor(() => expect(readGrokAuthSession).toHaveBeenCalledOnce())
      instance.stop()
      const stoppedState = instance.getState()
      auth.resolve({ status: 'missing' })
      await refresh
      expect(fetchGrokRateLimits).not.toHaveBeenCalled()
      expect(instance.getState()).toEqual(stoppedState)
    }
  )

  it('starts siblings without Grok auth and fences inputs invalidated while it is parked', async () => {
    const instance = service()
    const auth = deferred<Awaited<ReturnType<typeof readGrokAuthSession>>>()
    vi.mocked(readGrokAuthSession).mockReturnValueOnce(auth.promise)
    const opencode = deferred<Awaited<ReturnType<typeof fetchOpenCodeGoUsage>>>()
    const minimax = deferred<Awaited<ReturnType<typeof fetchMiniMaxRateLimits>>>()
    vi.mocked(fetchOpenCodeGoUsage).mockReturnValueOnce(opencode.promise)
    vi.mocked(fetchMiniMaxRateLimits).mockReturnValueOnce(minimax.promise)
    const refresh = instance.refresh()
    await vi.waitFor(() => {
      expect(readGrokAuthSession).toHaveBeenCalledOnce()
      expect(fetchCodexRateLimits).toHaveBeenCalledOnce()
      expect(fetchMiniMaxRateLimits).toHaveBeenCalledOnce()
    })
    instance.invalidateOpenCodeGoCredentialState()
    instance.invalidateMiniMaxCredentialState()
    const codex = deferred<Awaited<ReturnType<typeof fetchCodexRateLimits>>>()
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(codex.promise)
    const switchAccount = instance.refreshForCodexAccountChange('outgoing', { runtime: 'host' })
    auth.resolve({ status: 'missing' })
    opencode.resolve(okProvider('opencode-go', 71))
    minimax.resolve(okProvider('minimax', 61))
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2))
    expect(instance.getState().codex?.session).toBeNull()
    expect(instance.getState().opencodeGo?.session).toBeNull()
    expect(instance.getState().minimax?.session).toBeNull()
    codex.resolve(okProvider('codex', 9))
    await Promise.all([refresh, switchAccount])
    expect(instance.getState().codex?.session?.usedPercent).toBe(9)
  })
})
