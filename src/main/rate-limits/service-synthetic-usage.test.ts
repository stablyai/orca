import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchSyntheticRateLimits } from './synthetic-usage-fetcher'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
  flushMicrotasks,
  okProvider,
  errorProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

vi.mock('./synthetic-usage-fetcher', () => ({ fetchSyntheticRateLimits: vi.fn() }))
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
vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: vi.fn(() => false) }))

function quota(account: string, used = 20): ProviderRateLimits {
  return {
    ...okProvider('synthetic', used),
    requestQuota: { requests: used, limit: 100, renewsAt: Date.now() + 60_000 },
    usageMetadata: { authProvenance: account }
  }
}

beforeEach(() => {
  resetRateLimitProviderMocks()
  vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  vi.mocked(fetchSyntheticRateLimits).mockReset()
})

describe('Synthetic quota polling', () => {
  it('publishes Synthetic alongside the other providers', async () => {
    const service = new RateLimitService()
    service.setSyntheticApiKeyResolver(() => 'placeholder')
    vi.mocked(fetchSyntheticRateLimits).mockResolvedValue(quota('account-a'))
    await service.refresh()
    expect(fetchSyntheticRateLimits).toHaveBeenCalledWith('placeholder', expect.any(AbortSignal))
    expect(service.getState().synthetic?.requestQuota?.requests).toBe(20)
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('keeps the same account’s quota on a transient error but drops a different account’s', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchSyntheticRateLimits).mockResolvedValueOnce(quota('a'))
    await service.refresh()
    vi.mocked(fetchSyntheticRateLimits).mockResolvedValueOnce({
      ...errorProvider('synthetic', 'Unavailable'),
      usageMetadata: { authProvenance: 'a' }
    })
    await service.refresh()
    expect(service.getState().synthetic?.requestQuota?.requests).toBe(20)
    expect(service.getState().synthetic?.status).toBe('error')
    vi.mocked(fetchSyntheticRateLimits).mockResolvedValueOnce({
      ...errorProvider('synthetic', 'Unavailable'),
      usageMetadata: { authProvenance: 'b' }
    })
    await service.refresh()
    expect(service.getState().synthetic?.requestQuota).toBeUndefined()
  })

  it('discards in-flight results after a key change', async () => {
    const service = new RateLimitService()
    const first = deferred<ProviderRateLimits>()
    const second = deferred<ProviderRateLimits>()
    vi.mocked(fetchSyntheticRateLimits)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const pending = service.refresh()
    await flushMicrotasks()
    service.invalidateSyntheticCredentialState()
    const queued = service.refresh()
    first.resolve(quota('old'))
    await flushMicrotasks(20)
    expect(service.getState().synthetic?.requestQuota).toBeUndefined()
    second.resolve(quota('new', 10))
    await Promise.all([pending, queued])
    expect(service.getState().synthetic?.requestQuota?.requests).toBe(10)
  })

  it('isolates Synthetic resolver failures from other providers', async () => {
    const service = new RateLimitService()
    service.setSyntheticApiKeyResolver(() => {
      throw new Error('Unavailable')
    })
    await service.refresh()
    expect(service.getState().synthetic?.status).toBe('error')
    expect(service.getState().codex?.status).toBe('ok')
  })
})
