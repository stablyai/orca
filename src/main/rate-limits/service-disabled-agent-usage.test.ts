import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { okProvider, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

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

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

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

describe('RateLimitService disabled agent usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('makes no provider usage requests when the agents are disabled', async () => {
    const service = new RateLimitService()
    service.setClaudeAgentEnabledResolver(() => false)
    service.setCodexAgentEnabledResolver(() => false)

    await service.refresh()

    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('idle')
    expect(service.getState().codex?.status).toBe('idle')
    // Siblings without a disable switch keep polling.
    expect(service.getState().gemini?.status).toBe('ok')
  })

  it('polls again after the agent is re-enabled', async () => {
    const service = new RateLimitService()
    let claudeEnabled = false
    service.setClaudeAgentEnabledResolver(() => claudeEnabled)
    service.setCodexAgentEnabledResolver(() => false)

    await service.refresh()
    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()

    claudeEnabled = true
    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.status).toBe('ok')
    expect(service.getState().claude?.session?.usedPercent).toBe(7)
  })

  it('keeps the last reading when the agent is disabled mid-session', async () => {
    const service = new RateLimitService()
    let claudeEnabled = true
    service.setClaudeAgentEnabledResolver(() => claudeEnabled)
    service.setCodexAgentEnabledResolver(() => true)

    await service.refresh()
    expect(service.getState().codex?.session?.usedPercent).toBe(20)

    claudeEnabled = false
    await service.refresh()

    // Disabling must not flash away known usage; it only stops new requests.
    expect(service.getState().claude?.session?.usedPercent).toBe(7)
    expect(service.getState().claude?.status).toBe('ok')
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })
})
