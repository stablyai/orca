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

  it('does not republish the Gemini failure text under the Antigravity provider', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    // Why: a failed shared-quota read is a failed Antigravity read; only the wording is Antigravity's.
    expect(state.antigravity?.status).toBe('error')
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

  it('keeps the last shared-quota reading when the quota read fails, exactly as Gemini does', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    await service.refresh()

    // Why: one read backs both rows, so one failure must not wipe one row and spare the other.
    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.session?.usedPercent).toBe(42)
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('does not quote the Gemini failure while showing a retained Antigravity reading', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    await service.refresh()

    // Why: #15876's real protection — the Antigravity row owns its wording even in the failure lane.
    const antigravity = service.getState().antigravity
    expect(antigravity?.error).not.toContain('Token refresh failed')
    expect(antigravity?.error).toContain('shared Google Code Assist quota')
    // Why: retention is what makes this lane new — the tooltip prints this reason under
    // "Refresh failed — showing cached data" and directly above the retained meter, so a reason
    // that calls the usage unavailable contradicts the numbers rendered next to it.
    expect(antigravity?.session?.usedPercent).toBe(42)
    expect(antigravity?.error).not.toContain('not available')
  })
})
