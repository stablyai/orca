import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchNousRateLimits } from './nous-fetcher'
import { readNousAuthSession } from './nous-auth'
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

vi.mock('./nous-fetcher', () => ({
  fetchNousRateLimits: vi.fn()
}))

vi.mock('./nous-auth', () => ({
  readNousAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService nous usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches Nous alongside other providers and applies its snapshot', async () => {
    vi.mocked(readNousAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'at',
        refreshToken: 'rt',
        clientId: 'hermes-cli',
        portalBaseUrl: 'https://portal.nousresearch.com',
        expiresAtMs: Date.now() + 30 * 60 * 1000
      }
    })
    vi.mocked(fetchNousRateLimits).mockResolvedValue({
      provider: 'nous',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 42,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: null,
        usedAmount: 420,
        remainingAmount: 580
      },
      planType: 'Plus',
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })

    const service = new RateLimitService()
    await service.refresh()

    expect(fetchNousRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchNousRateLimits).toHaveBeenCalledWith({
      authReadResult: { status: 'ok', session: expect.objectContaining({ accessToken: 'at' }) }
    })
    const state = service.getState()
    expect(state.nous?.status).toBe('ok')
    expect(state.nous?.monthly?.usedPercent).toBe(42)
    expect(state.nousAuthConfigured).toBe(true)
  })

  it('reports nousAuthConfigured from the auth file probe even without a session', async () => {
    vi.mocked(readNousAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'at',
        refreshToken: null,
        clientId: 'hermes-cli',
        portalBaseUrl: 'https://portal.nousresearch.com',
        expiresAtMs: null
      }
    })
    const service = new RateLimitService()
    await service.refresh()
    expect(service.getState().nousAuthConfigured).toBe(true)
  })

  it('stays unavailable when no Hermes session exists', async () => {
    vi.mocked(readNousAuthSession).mockReturnValue({ status: 'missing' })
    const service = new RateLimitService()
    await service.refresh()
    expect(service.getState().nousAuthConfigured).toBe(false)
    expect(service.getState().nous?.status).toBe('unavailable')
  })
})
