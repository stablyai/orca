import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-fetcher'
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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./antigravity-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

function antigravityBucketsProvider(usedPercent: number): ReturnType<typeof okProvider> {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [
      {
        name: 'Gemini Weekly',
        usedPercent,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: null
      }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('reads its own quota independently of a failing Gemini fetch (provider isolation)', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(antigravityBucketsProvider(7))
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    // Why: the real Gemini failure must never leak into the Antigravity snapshot
    // (#9122/#19561) — Antigravity now has its own local-runtime fetcher.
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.error).toBeNull()
    expect(state.antigravity?.buckets?.[0]?.usedPercent).toBe(7)
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('stays unavailable when a successful Gemini read exists but Antigravity is not running (provider isolation)', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider('antigravity', 'Antigravity usage is not available.')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    // Why: Antigravity must never mirror Gemini's numbers — a Gemini success
    // says nothing about whether the Antigravity IDE is even running.
    expect(state.antigravity?.status).toBe('unavailable')
    expect(state.antigravity?.buckets).toBeUndefined()
    expect(state.gemini?.status).toBe('ok')
  })

  it('surfaces its own fetch error without touching Gemini state', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 5, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      errorProvider('antigravity', 'Antigravity quota request failed (HTTP 500)')
    )
    const service = new RateLimitService()

    await service.refresh()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toBe('Antigravity quota request failed (HTTP 500)')
    expect(state.gemini?.status).toBe('ok')
    expect(state.gemini?.error).toBeNull()
  })

  it('publishes a fresh Antigravity reading on every cycle', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(antigravityBucketsProvider(10))
    const service = new RateLimitService()
    await service.refresh()
    expect(service.getState().antigravity?.buckets?.[0]?.usedPercent).toBe(10)

    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(
      unavailableProvider('antigravity', 'Antigravity usage is not available.')
    )
    await service.refresh()

    // Why: stale-retention would otherwise keep showing the last-known numbers
    // as though the Antigravity IDE were still running.
    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.buckets).toBeUndefined()
  })
})
