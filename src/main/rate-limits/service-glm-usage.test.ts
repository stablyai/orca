import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGlmRateLimits } from './glm-fetcher'
import {
  deferred,
  flushMicrotasks,
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

vi.mock('./glm-fetcher', () => ({
  fetchGlmRateLimits: vi.fn()
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

describe('RateLimitService GLM usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches GLM alongside other providers when configured', async () => {
    const service = new RateLimitService()
    service.setGlmConfigResolver(() => ({ platform: 'zai', apiKey: 'tok-abc' }))
    vi.mocked(fetchGlmRateLimits).mockResolvedValueOnce(okProvider('glm', 33))

    await service.refresh()

    expect(fetchGlmRateLimits).toHaveBeenCalledWith({
      platform: 'zai',
      apiKey: 'tok-abc',
      signal: expect.any(AbortSignal)
    })
    const state = service.getState()
    expect(state.glm?.status).toBe('ok')
    expect(state.glm?.session?.usedPercent).toBe(33)
  })

  it('reports unavailable without fetching when no API key is set', async () => {
    const service = new RateLimitService()
    service.setGlmConfigResolver(() => null)

    await service.refresh()

    expect(fetchGlmRateLimits).not.toHaveBeenCalled()
    const state = service.getState()
    expect(state.glm?.status).toBe('unavailable')
  })

  it('isolates GLM failures from other providers', async () => {
    const service = new RateLimitService()
    service.setGlmConfigResolver(() => ({ platform: 'zhipu', apiKey: 'tok-abc' }))
    vi.mocked(fetchGlmRateLimits).mockRejectedValueOnce(new Error('glm down'))

    await service.refresh()

    const state = service.getState()
    expect(state.glm?.status).toBe('error')
    expect(state.glm?.error).toBe('glm down')
    expect(state.claude?.status).toBe('ok')
  })

  it('discards the previous GLM snapshot when its config hash changes', async () => {
    const service = new RateLimitService()
    let apiKey = 'tok-one'
    service.setGlmConfigResolver(() => ({ platform: 'zai', apiKey }))
    vi.mocked(fetchGlmRateLimits)
      .mockResolvedValueOnce(okProvider('glm', 40))
      .mockResolvedValueOnce(okProvider('glm', 10))

    await service.refresh()
    expect(service.getState().glm?.session?.usedPercent).toBe(40)

    apiKey = 'tok-two'
    await service.refresh()

    expect(fetchGlmRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().glm?.session?.usedPercent).toBe(10)
  })

  it('does not apply an in-flight GLM result fetched with a superseded config', async () => {
    const service = new RateLimitService()
    let apiKey = 'tok-one'
    service.setGlmConfigResolver(() => ({ platform: 'zai', apiKey }))
    const firstCycle = deferred<ProviderRateLimits>()
    const secondCycle = deferred<ProviderRateLimits>()
    vi.mocked(fetchGlmRateLimits)
      .mockImplementationOnce(() => firstCycle.promise)
      .mockImplementationOnce(() => secondCycle.promise)

    const first = service.refresh()
    await flushMicrotasks()

    apiKey = 'tok-two'
    const second = service.refresh()
    await flushMicrotasks()

    firstCycle.resolve(okProvider('glm', 50))
    await flushMicrotasks()

    expect(service.getState().glm?.session?.usedPercent).not.toBe(50)

    secondCycle.resolve(okProvider('glm', 10))
    await first
    await second

    expect(service.getState().glm?.session?.usedPercent).toBe(10)
  })
})
