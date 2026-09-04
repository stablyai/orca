import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchZaiRateLimits } from './zai-fetcher'
import {
  errorProvider,
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

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./zai-fetcher', () => ({
  fetchZaiRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

function zaiOk(usedPercent: number, updatedAt = Date.now()) {
  return { ...okProvider('zai', usedPercent, updatedAt), usageMetadata: { source: 'web' as const } }
}

function zaiMissingCredentials() {
  return {
    ...unavailableProvider('zai'),
    usageMetadata: { failureKind: 'missing-credentials' as const }
  }
}

describe('RateLimitService Z.AI usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches Z.AI concurrently with the other providers and passes the cycle signal', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchZaiRateLimits).mockResolvedValue(zaiOk(42))

    const state = await service.refresh()

    expect(fetchZaiRateLimits).toHaveBeenCalledTimes(1)
    const [options] = vi.mocked(fetchZaiRateLimits).mock.calls[0]
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(state.zai).toMatchObject({ provider: 'zai', status: 'ok' })
    expect(state.zai?.session?.usedPercent).toBe(42)
    // Why: a settled quota answer implies the fetcher's own auth read found a key.
    expect(state.zaiAuthConfigured).toBe(true)
  })

  it('reports zaiAuthConfigured false when the settled result lacks credentials', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchZaiRateLimits).mockResolvedValue(zaiMissingCredentials())

    const state = await service.refresh()

    expect(state.zai).toMatchObject({ provider: 'zai', status: 'unavailable' })
    expect(state.zaiAuthConfigured).toBe(false)
  })

  it('keeps zaiAuthConfigured true through a transient error so the bar does not drop', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchZaiRateLimits).mockResolvedValueOnce(zaiOk(10))
    await service.refresh()

    vi.mocked(fetchZaiRateLimits).mockResolvedValue(errorProvider('zai', 'network down'))
    const state = await service.refresh()

    expect(state.zaiAuthConfigured).toBe(true)
    expect(state.zai?.status).toBe('error')
  })

  it('keeps a recent snapshot through a failed cycle instead of flapping to empty', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchZaiRateLimits).mockResolvedValue(zaiOk(33))
    await service.refresh()

    vi.mocked(fetchZaiRateLimits).mockResolvedValue(errorProvider('zai', 'usage unavailable'))
    const state = await service.refresh()

    expect(state.zai).toMatchObject({
      provider: 'zai',
      status: 'error',
      session: { usedPercent: 33 }
    })
  })

  it('drops a stale snapshot once it ages past the stale threshold', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      vi.mocked(fetchZaiRateLimits).mockResolvedValue(zaiOk(33))
      await service.refresh()

      vi.advanceTimersByTime(31 * 60 * 1000)
      vi.mocked(fetchZaiRateLimits).mockResolvedValue(errorProvider('zai', 'usage unavailable'))
      const state = await service.refresh()

      expect(state.zai).toMatchObject({ provider: 'zai', status: 'error', session: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a rejected fetch as a zai error result instead of crashing the cycle', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchZaiRateLimits).mockRejectedValueOnce(new Error('socket hang up'))

    const state = await service.refresh()

    expect(state.zai).toMatchObject({
      provider: 'zai',
      status: 'error',
      error: 'Z.ai usage request failed unexpectedly'
    })
    expect(state.zai?.error).not.toContain('socket hang up')
    // Why: only an explicit missing-credentials answer may flip the durable flag off.
    expect(state.zaiAuthConfigured).toBe(true)
  })
})
