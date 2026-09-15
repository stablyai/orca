import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import {
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
} from './rate-limit-service-test-harness'

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

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

  it('publishes Antigravity usage while Gemini is failing', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 42))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(42)
    expect(state.gemini?.status).toBe('error')
  })

  it('never leaves an unreachable language server in the error retry lane', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(okProvider('antigravity', 42))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(unavailableProvider('antigravity'))
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.session).toBeNull()
  })
})
