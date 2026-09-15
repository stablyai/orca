import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { ANTIGRAVITY_NO_NATIVE_SOURCE_REASON } from './antigravity-native-usage-source'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
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

vi.mock('./minimax/minimax-fetcher', () => ({
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

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('does not republish a Gemini failure as an Antigravity failure', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.error).not.toContain('Gemini project ID not found')
    expect(state.antigravity?.session).toBeNull()
    // Why: the real Gemini failure must still surface under its own provider.
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('never surfaces successful Gemini quota under the Antigravity label (#14515)', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue({
      ...okProvider('gemini', 42, Date.now()),
      buckets: [
        {
          name: 'Gemini 3 Pro',
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ]
    })
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.session).toBeNull()
    expect(state.antigravity?.buckets).toBeUndefined()
    expect(state.antigravity?.error).toBe(ANTIGRAVITY_NO_NATIVE_SOURCE_REASON)
    // Why: Gemini's own snapshot is untouched; only the impersonation is gone.
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('reports native unavailability when no Gemini CLI sign-in exists at all (#9122)', async () => {
    // Why: "no Gemini binary" is the #9122 repro; Antigravity must not inherit that failure
    // or name Gemini in its own reason.
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      unavailableProvider('gemini', 'Gemini CLI credentials not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const antigravity = service.getState().antigravity
    expect(antigravity?.provider).toBe('antigravity')
    expect(antigravity?.status).toBe('unavailable')
    expect(antigravity?.error).not.toMatch(/gemini/i)
    expect(antigravity?.error).toBe(ANTIGRAVITY_NO_NATIVE_SOURCE_REASON)
  })

  it('never leaves a cached Antigravity snapshot in the error retry lane', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.session).toBeNull()
  })
})
