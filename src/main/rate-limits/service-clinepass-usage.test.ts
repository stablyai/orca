import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchClinePassRateLimits } from './clinepass-fetcher'
import { hasClinePassApiKey, readClinePassApiKey } from '../clinepass/clinepass-api-key-store'
import {
  deferred,
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

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./clinepass-fetcher', () => ({
  fetchClinePassRateLimits: vi.fn()
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

vi.mock('../clinepass/clinepass-api-key-store', () => ({
  hasClinePassApiKey: vi.fn(() => false),
  readClinePassApiKey: vi.fn(() => null)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchClinePassRateLimits).mockResolvedValue(
      unavailableProvider('clinepass', 'ClinePass API key not configured')
    )
    vi.mocked(hasClinePassApiKey).mockReturnValue(false)
    vi.mocked(readClinePassApiKey).mockReturnValue(null)
  })

  it('reports clinePassApiKeyConfigured from the credential store', () => {
    const service = new RateLimitService()
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    expect(service.getState().clinePassApiKeyConfigured).toBe(true)
  })

  it('fetches ClinePass alongside other providers when an API key is configured', async () => {
    const service = new RateLimitService()
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    vi.mocked(readClinePassApiKey).mockReturnValue('cp-test-key')
    vi.mocked(fetchClinePassRateLimits).mockResolvedValueOnce(
      okProvider('clinepass', 42, Date.now())
    )
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    expect(fetchClinePassRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchClinePassRateLimits).toHaveBeenCalledWith('cp-test-key', {
      signal: expect.any(AbortSignal)
    })
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

    const state = service.getState()
    expect(state.clinePass?.status).toBe('ok')
    expect(state.clinePass?.session?.usedPercent).toBe(42)
    expect(state.claude?.status).toBe('ok')
    expect(state.clinePassApiKeyConfigured).toBe(true)
  })

  it('surfaces missing ClinePass credentials without blocking other providers', async () => {
    const service = new RateLimitService()
    vi.mocked(hasClinePassApiKey).mockReturnValue(false)
    vi.mocked(readClinePassApiKey).mockReturnValue(null)
    vi.mocked(fetchClinePassRateLimits).mockResolvedValueOnce(
      unavailableProvider('clinepass', 'ClinePass API key not configured')
    )
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    expect(fetchClinePassRateLimits).toHaveBeenCalledWith('', {
      signal: expect.any(AbortSignal)
    })
    const state = service.getState()
    expect(state.clinePass?.status).toBe('unavailable')
    expect(state.claude?.status).toBe('ok')
    expect(state.clinePassApiKeyConfigured).toBe(false)
  })

  it('isolates ClinePass credential-read failures from other providers', async () => {
    const service = new RateLimitService()
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    vi.mocked(readClinePassApiKey).mockImplementation(() => {
      throw new Error('ClinePass API key could not be decrypted')
    })
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    const state = service.getState()
    expect(fetchClinePassRateLimits).not.toHaveBeenCalled()
    expect(state.clinePass?.status).toBe('error')
    expect(state.clinePass?.error).toBe('ClinePass API key could not be decrypted')
    expect(state.claude?.status).toBe('ok')
  })

  it('discards the previous ClinePass snapshot when the API key changes', async () => {
    const service = new RateLimitService()
    let apiKey = 'cp-key-a'
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    vi.mocked(readClinePassApiKey).mockImplementation(() => apiKey)
    vi.mocked(fetchClinePassRateLimits)
      .mockResolvedValueOnce(okProvider('clinepass', 40, Date.now()))
      .mockResolvedValueOnce(okProvider('clinepass', 10, Date.now()))

    await service.refresh()
    expect(service.getState().clinePass?.session?.usedPercent).toBe(40)

    apiKey = 'cp-key-b'
    await service.refresh()

    const state = service.getState()
    expect(fetchClinePassRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchClinePassRateLimits).toHaveBeenNthCalledWith(1, 'cp-key-a', {
      signal: expect.any(AbortSignal)
    })
    expect(fetchClinePassRateLimits).toHaveBeenNthCalledWith(2, 'cp-key-b', {
      signal: expect.any(AbortSignal)
    })
    expect(state.clinePass?.session?.usedPercent).toBe(10)
  })

  it('does not apply an in-flight ClinePass result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstClinePass = deferred<ProviderRateLimits>()
    const secondClinePass = deferred<ProviderRateLimits>()
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    vi.mocked(readClinePassApiKey).mockReturnValue('cp-test-key')
    vi.mocked(fetchClinePassRateLimits)
      .mockImplementationOnce(() => firstClinePass.promise)
      .mockImplementationOnce(() => secondClinePass.promise)

    const firstRefresh = service.refresh()
    await Promise.resolve()

    service.invalidateClinePassCredentialState()
    const queuedRefresh = service.refresh()
    await Promise.resolve()

    firstClinePass.resolve(okProvider('clinepass', 50, Date.now()))
    await Promise.resolve()
    await Promise.resolve()

    expect(service.getState().clinePass?.status).toBe('fetching')
    expect(service.getState().clinePass?.session).toBeNull()

    secondClinePass.resolve(okProvider('clinepass', 10, Date.now()))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchClinePassRateLimits).toHaveBeenCalledTimes(2)
    expect(state.clinePass?.session?.usedPercent).toBe(10)
  })

  it('isolates ClinePass fetch failures from other providers', async () => {
    const service = new RateLimitService()
    vi.mocked(hasClinePassApiKey).mockReturnValue(true)
    vi.mocked(readClinePassApiKey).mockReturnValue('cp-test-key')
    vi.mocked(fetchClinePassRateLimits).mockRejectedValueOnce(new Error('clinepass down'))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))

    await service.refresh()

    const state = service.getState()
    expect(state.clinePass?.status).toBe('error')
    expect(state.clinePass?.error).toBe('clinepass down')
    expect(state.claude?.status).toBe('ok')
  })
})
