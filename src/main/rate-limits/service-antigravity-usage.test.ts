import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { readAntigravityAuthSession } from './antigravity-oauth-sources'
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

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./antigravity-oauth-sources', () => ({
  readAntigravityAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

const signedInSession = {
  status: 'ok' as const,
  session: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
    authMethod: 'consumer',
    email: 'dev@example.com'
  }
}

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
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('fetches Antigravity independently of Gemini usage', async () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue(signedInSession)
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      okProvider('antigravity', 11, Date.now())
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(fetchAntigravityRateLimits).toHaveBeenCalled()
    expect(state.gemini?.session?.usedPercent).toBe(42)
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    expect(state.antigravity?.session?.usedPercent).toBe(11)
    expect(state.antigravityAuthConfigured).toBe(true)
  })

  it('keeps a successful Antigravity snapshot when Gemini later fails', async () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue(signedInSession)
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      okProvider('antigravity', 11, Date.now())
    )
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Token refresh failed')
    )
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('ok')
    expect(service.getState().antigravity?.session?.usedPercent).toBe(11)
    expect(service.getState().gemini?.status).toBe('error')
  })

  it('treats a signed-in CLI without Code Assist quota as unavailable, not unsigned', async () => {
    vi.mocked(readAntigravityAuthSession).mockReturnValue(signedInSession)
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider(
        'antigravity',
        'Antigravity CLI is signed in. Orca could not read a Code Assist quota for this account.'
      )
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravityAuthConfigured).toBe(true)
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.error).toContain('signed in')
    expect(state.antigravity?.error).not.toContain('not signed in')
  })
})
