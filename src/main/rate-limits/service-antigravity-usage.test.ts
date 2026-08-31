import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import {
  deferred,
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
} from './rate-limit-service-test-harness'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

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

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

function agyProvider(sessionUsedPercent: number, weeklyUsedPercent: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      usedPercent: sessionUsedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: weeklyUsedPercent,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    buckets: [
      {
        name: 'Gemini Models · 5h',
        usedPercent: 20,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      {
        name: 'Claude and GPT models · 5h',
        usedPercent: sessionUsedPercent,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('passes the selected WSL execution host to Antigravity discovery', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(agyProvider(90, 50))
    const service = new RateLimitService()
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    await service.refresh()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
  })

  it('discards an in-flight result after the Antigravity runtime target changes', async () => {
    const hostFetch = deferred<ProviderRateLimits>()
    vi.mocked(fetchAntigravityRateLimits)
      .mockReturnValueOnce(hostFetch.promise)
      .mockResolvedValueOnce(agyProvider(80, 40))
    const service = new RateLimitService()
    const observed: (ProviderRateLimits | null)[] = []
    service.onStateChange((state) => observed.push(state.antigravity))

    const hostRefresh = service.refresh()
    await vi.waitFor(() => expect(fetchAntigravityRateLimits).toHaveBeenCalledOnce())
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    const wslRefresh = service.refresh()
    hostFetch.resolve(agyProvider(10, 5))

    await Promise.all([hostRefresh, wslRefresh])

    expect(fetchAntigravityRateLimits).toHaveBeenNthCalledWith(1, {
      signal: expect.any(AbortSignal),
      target: { runtime: 'host', wslDistro: null }
    })
    expect(fetchAntigravityRateLimits).toHaveBeenNthCalledWith(2, {
      signal: expect.any(AbortSignal),
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    expect(observed.some((limits) => limits?.session?.usedPercent === 10)).toBe(false)
    expect(service.getState().antigravity?.session?.usedPercent).toBe(80)
  })

  it('discards an in-flight result after the runtime target changes away and back', async () => {
    const firstHostFetch = deferred<ProviderRateLimits>()
    vi.mocked(fetchAntigravityRateLimits)
      .mockReturnValueOnce(firstHostFetch.promise)
      .mockResolvedValueOnce(agyProvider(70, 30))
    const service = new RateLimitService()
    const observed: (ProviderRateLimits | null)[] = []
    service.onStateChange((state) => observed.push(state.antigravity))

    const firstRefresh = service.refresh()
    await vi.waitFor(() => expect(fetchAntigravityRateLimits).toHaveBeenCalledOnce())
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    service.setAntigravityFetchTarget({ runtime: 'host', wslDistro: null })
    const currentRefresh = service.refresh()
    firstHostFetch.resolve(agyProvider(10, 5))

    await Promise.all([firstRefresh, currentRefresh])

    expect(observed.some((limits) => limits?.session?.usedPercent === 10)).toBe(false)
    expect(service.getState().antigravity?.session?.usedPercent).toBe(70)
  })

  // Why: this is the defect in #9122 — the Antigravity segment was `{...gemini, provider:
  // 'antigravity'}`, so it reported Gemini Code Assist per-model quota under an Antigravity label.
  it('publishes Agy-native quota instead of a copy of the Gemini snapshot', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(agyProvider(90, 50))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(90)
    expect(state.antigravity?.session?.usedPercent).not.toBe(state.gemini?.session?.usedPercent)
    expect(state.antigravity?.buckets?.map((bucket) => bucket.name)).toContain(
      'Claude and GPT models · 5h'
    )
  })

  // Why: refresh used to hard-depend on a local Gemini CLI install; without one the segment
  // showed "Token refresh failed" forever even though Antigravity itself was healthy.
  it('reports Antigravity quota while the Gemini fetch is failing', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(agyProvider(12, 8))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.error).toBeNull()
    expect(state.antigravity?.session?.usedPercent).toBe(12)
    // Why: the real Gemini failure must still surface under its own provider.
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Token refresh failed')
  })

  it('does not let an Antigravity failure quote the Gemini error', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider(
        'antigravity',
        'Antigravity usage is not available. Start the Antigravity CLI (agy) so Orca can read its quota.'
      )
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.error).not.toContain('Gemini project ID not found')
    expect(state.antigravity?.session).toBeNull()
  })

  // Why: a Gemini success used to overwrite Antigravity state on every cycle.
  it('keeps Antigravity unavailable while Gemini succeeds', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(unavailableProvider('antigravity'))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.session).toBeNull()
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('surfaces a thrown Antigravity fetch as a provider error, not a crashed cycle', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockRejectedValue(new Error('loopback exploded'))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toBe('loopback exploded')
    expect(state.claude?.status).toBe('ok')
  })

  it('never leaves a cached Antigravity snapshot in the error retry lane', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(agyProvider(30, 10))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(unavailableProvider('antigravity'))
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.session).toBeNull()
  })
})
