import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchAntigravityRateLimits } from './antigravity-quota-fetcher'
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

vi.mock('./antigravity-quota-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))

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

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('publishes other providers while the Antigravity process is pending', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fetchAntigravityRateLimits>>>()
    vi.mocked(fetchAntigravityRateLimits).mockReturnValue(pending.promise)
    const service = new RateLimitService()
    const refresh = service.refresh()
    try {
      await vi.waitFor(() => {
        expect(service.getState().codex?.status).toBe('ok')
        expect(service.getState().grok?.status).not.toBe('fetching')
        expect(service.getState().antigravity?.status).toBe('fetching')
      })
    } finally {
      pending.resolve(okProvider('antigravity', 42))
      await refresh
    }
    expect(service.getState().antigravity?.session?.usedPercent).toBe(42)
  })

  it('uses the Antigravity CLI read even when the Gemini read fails', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      okProvider('antigravity', 42, Date.now())
    )
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    expect(state.antigravity?.session?.usedPercent).toBe(42)
    // Why: the real Gemini failure must still surface under its own provider.
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('borrows a successful Gemini read only when the CLI read produced nothing', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider('antigravity', 'Antigravity CLI not found')
    )
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 33, Date.now()))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(33)
  })

  it('surfaces the CLI failure instead of the Gemini failure when both fail', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'Antigravity quota request failed')
    )
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toBe('Antigravity quota request failed')
    expect(state.antigravity?.error).not.toContain('Gemini project ID not found')
  })

  it('reports unavailable when neither the CLI nor a Gemini sign-in can produce data', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider('antigravity', 'Antigravity CLI not found')
    )
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(unavailableProvider('gemini'))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.session).toBeNull()
  })
})
