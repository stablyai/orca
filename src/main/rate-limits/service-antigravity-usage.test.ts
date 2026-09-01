import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { readAntigravityCredentials } from './antigravity-credentials'
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

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn(),
  probeAntigravityAuthConfigured: vi.fn((result: { status: string }) => result.status === 'ok')
}))

vi.mock('./antigravity-credentials', () => ({
  readAntigravityCredentials: vi.fn(async () => ({ status: 'missing' as const }))
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
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('fetches Antigravity independently of Gemini', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 90, Date.now()))
    vi.mocked(readAntigravityCredentials).mockResolvedValue({
      status: 'ok',
      credentials: {
        accessToken: 'a',
        refreshToken: 'r'
      }
    })
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue({
      provider: 'antigravity',
      session: {
        usedPercent: 32,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 18,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      },
      buckets: [
        {
          name: 'Claude',
          usedPercent: 32,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Claude W',
          usedPercent: 18,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Gemini',
          usedPercent: 58,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Gemini W',
          usedPercent: 24,
          windowMinutes: 10_080,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.session?.usedPercent).toBe(90)
    expect(state.antigravity?.session?.usedPercent).toBe(32)
    expect(
      state.antigravity?.buckets?.find((bucket) => bucket.name === 'Gemini')?.usedPercent
    ).toBe(58)
    expect(state.antigravity?.buckets?.map((bucket) => bucket.name)).toEqual([
      'Claude',
      'Claude W',
      'Gemini',
      'Gemini W'
    ])
    expect(state.antigravityAuthConfigured).toBe(true)
    expect(fetchAntigravityRateLimits).toHaveBeenCalledWith({
      credentialsReadResult: expect.objectContaining({ status: 'ok' }),
      signal: expect.any(AbortSignal)
    })
  })

  it('keeps Antigravity healthy when Gemini fails', async () => {
    vi.mocked(fetchGeminiRateLimits).mockRejectedValue(new Error('gemini down'))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 15))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('gemini down')
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.session?.usedPercent).toBe(15)
    expect(state.antigravity?.buckets ?? []).toHaveLength(0)
  })

  it('does not treat a missing login as configured Antigravity auth', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider(
        'antigravity',
        'Antigravity login not found — sign in to Antigravity first'
      )
    )
    const service = new RateLimitService()

    await service.refresh()

    expect(service.getState().antigravityAuthConfigured).toBe(false)
    expect(service.getState().antigravity?.status).toBe('unavailable')
  })
})
