import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import {
  errorProvider,
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

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('does not republish a Gemini failure as an Antigravity refresh failure', async () => {
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

  it('keeps mirroring a successful Gemini read under the Antigravity provider', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    expect(state.antigravity?.session?.usedPercent).toBe(42)
  })

  it('never leaves a cached Antigravity snapshot in the error retry lane', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    await service.refresh()

    // Why: stale-retention would otherwise show Gemini numbers as "Refresh failed" Antigravity usage.
    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.session).toBeNull()
  })
})
