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
  resetRateLimitProviderMocks
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
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'agy unavailable')
    )
  })

  it('does not republish a Gemini failure as an Antigravity refresh failure', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).not.toContain('Gemini project ID not found')
    expect(state.antigravity?.session).toBeNull()
    // Why: the real Gemini failure must still surface under its own provider.
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('keeps Gemini and Antigravity results independent', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      okProvider('antigravity', 8, Date.now())
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.session?.usedPercent).toBe(42)
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    expect(state.antigravity?.session?.usedPercent).toBe(8)
  })

  it('reads the current runtime launch override on each quota refresh', async () => {
    const service = new RateLimitService()
    let command = '/custom/agy'
    service.setAntigravityCommandResolver(() => command)
    await service.refresh()
    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(expect.any(AbortSignal), command)
    command = '/replacement/agy'
    await service.refresh()
    expect(fetchAntigravityRateLimits).toHaveBeenLastCalledWith(expect.any(AbortSignal), command)
  })

  it('drops an in-flight quota response after the configured executable changes', async () => {
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchAntigravityRateLimits).mockReturnValueOnce(pending.promise)
    const service = new RateLimitService()
    let command = '/first/agy'
    service.setAntigravityCommandResolver(() => command)
    const refresh = service.refresh()
    await vi.waitFor(() => expect(fetchAntigravityRateLimits).toHaveBeenCalled())
    command = '/second/agy'
    pending.resolve(okProvider('antigravity', 75))
    await refresh
    expect(service.getState().antigravity).toBeNull()
  })

  it('does not retain the old executable quota when the replacement fails', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(okProvider('antigravity', 75))
    const service = new RateLimitService()
    let command = '/first/agy'
    service.setAntigravityCommandResolver(() => command)
    await service.refresh()
    command = '/second/agy'
    await service.refresh()
    expect(service.getState().antigravity?.session).toBeNull()
    expect(service.getState().antigravity?.status).toBe('error')
  })

  it('never leaves a cached Antigravity snapshot in the error retry lane', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(
      okProvider('antigravity', 18, Date.now())
    )
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'agy temporary failure')
    )
    await service.refresh()

    // Why: stale-retention must not substitute Gemini numbers for Antigravity.
    expect(service.getState().antigravity?.status).toBe('error')
    expect(service.getState().antigravity?.session?.usedPercent).toBe(18)
  })
})
