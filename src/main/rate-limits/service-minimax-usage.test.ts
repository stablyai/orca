import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { hasMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
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
    // Why: these cases only stub MiniMax, so the surrounding fetch cycle still
    // needs healthy Claude/Codex results — previously inherited implicitly from
    // earlier tests' persistent mocks (clearAllMocks keeps implementations).
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches MiniMax alongside other providers when a config resolver is set', async () => {
    const service = new RateLimitService()
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '_token=abc; minimax_group_id_v2=42',
      groupId: '',
      models: 'general'
    }))
    vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(true)
    vi.mocked(fetchMiniMaxRateLimits).mockResolvedValueOnce(okProvider('minimax', 50, Date.now()))

    await service.refresh()

    expect(fetchMiniMaxRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchMiniMaxRateLimits).toHaveBeenCalledWith({
      cookie: '_token=abc; minimax_group_id_v2=42',
      groupId: '',
      models: 'general'
    })

    const state = service.getState()
    expect(state.minimax?.status).toBe('ok')
    expect(state.minimax?.session?.usedPercent).toBe(50)
    expect(state.minimaxCookieConfigured).toBe(true)
  })

  it('reports minimaxCookieConfigured from the cookie store even without a resolver', () => {
    const service = new RateLimitService()
    vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(true)
    expect(service.getState().minimaxCookieConfigured).toBe(true)
  })

  it('discards the previous MiniMax snapshot when its config hash changes', async () => {
    const service = new RateLimitService()
    let models = 'general'
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '_token=abc',
      groupId: '',
      models
    }))
    vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(true)
    vi.mocked(fetchMiniMaxRateLimits)
      .mockResolvedValueOnce(okProvider('minimax', 40, Date.now()))
      .mockResolvedValueOnce(okProvider('minimax', 10, Date.now()))

    await service.refresh()
    expect(service.getState().minimax?.session?.usedPercent).toBe(40)

    models = 'premium'
    await service.refresh()

    const state = service.getState()
    expect(fetchMiniMaxRateLimits).toHaveBeenCalledTimes(2)
    expect(state.minimax?.session?.usedPercent).toBe(10)
  })

  it('does not apply an in-flight MiniMax result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstMiniMax = deferred<ProviderRateLimits>()
    const secondMiniMax = deferred<ProviderRateLimits>()
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '_token=abc',
      groupId: '',
      models: 'general'
    }))
    vi.mocked(fetchMiniMaxRateLimits)
      .mockImplementationOnce(() => firstMiniMax.promise)
      .mockImplementationOnce(() => secondMiniMax.promise)

    const firstRefresh = service.refresh()
    await Promise.resolve()

    service.invalidateMiniMaxCredentialState()
    const queuedRefresh = service.refresh()
    await Promise.resolve()

    firstMiniMax.resolve(okProvider('minimax', 50, Date.now()))
    await Promise.resolve()
    await Promise.resolve()

    expect(service.getState().minimax?.status).toBe('fetching')
    expect(service.getState().minimax?.session).toBeNull()

    secondMiniMax.resolve(okProvider('minimax', 10, Date.now()))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchMiniMaxRateLimits).toHaveBeenCalledTimes(2)
    expect(state.minimax?.session?.usedPercent).toBe(10)
  })

  it('isolates MiniMax failures from other providers', async () => {
    const service = new RateLimitService()
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '_token=abc',
      groupId: '',
      models: 'general'
    }))
    vi.mocked(fetchMiniMaxRateLimits).mockRejectedValueOnce(new Error('minimax down'))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    const state = service.getState()
    expect(state.minimax?.status).toBe('error')
    expect(state.minimax?.error).toBe('minimax down')
    expect(state.claude?.status).toBe('ok')
  })

  it('isolates MiniMax config resolver failures from other providers', async () => {
    const service = new RateLimitService()
    service.setMiniMaxConfigResolver(() => {
      throw new Error('MiniMax session cookie could not be decrypted')
    })
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    const state = service.getState()
    expect(fetchMiniMaxRateLimits).not.toHaveBeenCalled()
    expect(state.minimax?.status).toBe('error')
    expect(state.minimax?.error).toBe('MiniMax session cookie could not be decrypted')
    expect(state.claude?.status).toBe('ok')
  })
})
