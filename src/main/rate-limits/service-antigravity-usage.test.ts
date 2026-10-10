import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
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
vi.mock('./copilot-usage-fetcher', () => ({
  fetchCopilotRateLimits: vi.fn(async () => ({
    provider: 'copilot',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: 0,
    error: null,
    status: 'unavailable'
  }))
}))

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

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
  })

  it('publishes the Antigravity CLI reading, not the Gemini one', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    // Why both: the mirror made these two numbers the same value by construction.
    expect(state.antigravity?.session?.usedPercent).toBe(30)
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('keeps an Antigravity reading through a Gemini failure', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 55))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    // Why: the two providers no longer share a credential or an endpoint, so a Gemini
    // token problem is not evidence about Antigravity quota (#9122).
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(55)
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('reports an Antigravity failure without touching Gemini', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'The Antigravity CLI did not report a quota.')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.session).toBeNull()
    expect(state.gemini?.status).toBe('ok')
  })

  it('surfaces a rejected Antigravity fetch as that provider\u2019s error', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockRejectedValue(new Error('spawn agy ENOENT'))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toContain('spawn agy ENOENT')
    // Why: a thrown Antigravity fetch must not abort the cycle for everyone else.
    expect(state.claude?.status).toBe('ok')
    expect(state.gemini?.status).toBe('ok')
  })
})

describe('Antigravity usage gating', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  })

  it('never spawns agy when the usage meter is hidden', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    service.setAntigravityUsageEnabledResolver(() => false)

    await service.refresh()

    // Why: the probe starts the agy language server for ~2.5 s. A user not showing the meter
    // should not pay that every cycle.
    expect(fetchAntigravityRateLimits).not.toHaveBeenCalled()
    expect(service.getState().antigravity?.status).toBe('idle')
    // Why the rest must be untouched: gating one provider cannot gate the cycle.
    expect(service.getState().gemini?.status).toBe('ok')
  })

  it('spawns agy when the meter is shown', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    service.setAntigravityUsageEnabledResolver(() => true)

    await service.refresh()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().antigravity?.status).toBe('ok')
  })

  it('fetches when no resolver is configured', async () => {
    // Why default-on: the status bar shows Antigravity by default, so an unconfigured service
    // must still fill the meter rather than silently reporting nothing.
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()

    await service.refresh()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
  })

  it('keeps the last reading when the meter is hidden mid-session', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 44))
    const service = new RateLimitService()
    let enabled = true
    service.setAntigravityUsageEnabledResolver(() => enabled)
    await service.refresh()
    expect(service.getState().antigravity?.session?.usedPercent).toBe(44)

    enabled = false
    await service.refresh()

    // Why kept: hiding the meter is not evidence the quota changed, and re-showing it should not
    // flash an empty segment while the next poll runs.
    expect(service.getState().antigravity?.session?.usedPercent).toBe(44)
    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
  })
})
