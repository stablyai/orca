import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchMiniMaxRateLimits } from '../providers/minimax/minimax-fetcher'
import {
  deferred,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))

vi.mock('../providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('../providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    // Seed healthy siblings explicitly; clearAllMocks retains implementations from earlier cases.
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
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
