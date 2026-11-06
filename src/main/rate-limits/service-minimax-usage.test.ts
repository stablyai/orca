import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
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

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    // Seed healthy siblings explicitly; clearAllMocks retains implementations from earlier cases.
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('clears the old quota when replacing a non-empty API key and the refresh fails', async () => {
    const service = new RateLimitService()
    let apiKey = 'sk-account-a'
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '',
      groupId: '',
      models: 'general',
      endpoint: 'cn',
      apiKey
    }))
    vi.mocked(fetchMiniMaxRateLimits)
      .mockResolvedValueOnce(okProvider('minimax', 40, Date.now()))
      .mockRejectedValueOnce(new Error('MiniMax unavailable'))

    await service.refresh()
    expect(service.getState().minimax?.session?.usedPercent).toBe(40)

    apiKey = 'sk-account-b'
    await service.refresh()

    expect(service.getState().minimax?.status).toBe('error')
    expect(service.getState().minimax?.session).toBeNull()
    expect(fetchMiniMaxRateLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'sk-account-b' })
    )
  })

  it('does not apply an in-flight MiniMax result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstMiniMax = deferred<ProviderRateLimits>()
    const secondMiniMax = deferred<ProviderRateLimits>()
    service.setMiniMaxConfigResolver(() => ({
      sessionCookie: '_token=abc',
      groupId: '',
      models: 'general',
      endpoint: 'overseas',
      apiKey: ''
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
})
