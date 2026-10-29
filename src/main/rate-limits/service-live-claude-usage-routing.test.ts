import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import {
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

const profileRouter = vi.hoisted((): { userConfigDir?: string } => ({}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    profileRouter.userConfigDir ? { userConfigDir: () => profileRouter.userConfigDir } : undefined
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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

const HOMES: Record<string, string> = {
  a: '/data/claude-profiles/a/home',
  b: '/data/claude-profiles/b/home',
  c: '/data/claude-profiles/c/home'
}

class LiveRoutingService extends RateLimitService {
  seedPolledReading(accountId: string, reading: ProviderRateLimits) {
    this.inactiveClaudeCache.set(accountId, reading)
  }
}

function service(): LiveRoutingService {
  const rateLimits = new LiveRoutingService()
  rateLimits.setInactiveClaudeAccountsResolver(() => [{ id: 'b' }, { id: 'c' }])
  rateLimits.setLiveClaudeAccountResolver(
    (configDir) => Object.entries(HOMES).find(([, home]) => home === configDir)?.[0] ?? null
  )
  return rateLimits
}

describe('RateLimitService live Claude usage routing', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it("lands a non-selected managed account's statusline post in that account's entry", () => {
    const rateLimits = service()
    rateLimits.ingestLiveClaudeRateLimits({
      configDir: '/data/claude-profiles/b/home/',
      fiveHour: { used_percentage: 96, resets_at: Math.floor(Date.now() / 1000) + 600 },
      sevenDay: { used_percentage: 41 }
    })
    const state = rateLimits.getState()
    expect(state.claude).toBeNull()
    const b = state.inactiveClaudeAccounts.find((usage) => usage.accountId === 'b')
    expect(b?.rateLimits?.session?.usedPercent).toBe(96)
    expect(b?.rateLimits?.weekly?.usedPercent).toBe(41)
    expect(b?.rateLimits?.status).toBe('ok')
    expect(b?.rateLimits?.usageMetadata).toMatchObject({
      source: 'live-session',
      authProvenance: 'profile:b'
    })
    expect(b?.isFetching).toBe(false)
  })

  it('keeps a window the post did not carry and ignores a same-value repeat inside the dedupe window', () => {
    vi.useFakeTimers()
    try {
      const rateLimits = service()
      const listener = vi.fn()
      rateLimits.onStateChange(listener)
      rateLimits.ingestLiveClaudeRateLimits({
        configDir: HOMES.c,
        fiveHour: { used_percentage: 10 },
        sevenDay: { used_percentage: 70 }
      })
      rateLimits.ingestLiveClaudeRateLimits({
        configDir: HOMES.c,
        fiveHour: { used_percentage: 12 },
        sevenDay: null
      })
      const c = rateLimits
        .getState()
        .inactiveClaudeAccounts.find((usage) => usage.accountId === 'c')
      expect(c?.rateLimits?.session?.usedPercent).toBe(12)
      expect(c?.rateLimits?.weekly?.usedPercent).toBe(70)
      const publishes = listener.mock.calls.length
      rateLimits.ingestLiveClaudeRateLimits({
        configDir: HOMES.c,
        fiveHour: { used_percentage: 12 },
        sevenDay: null
      })
      expect(listener.mock.calls.length).toBe(publishes)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps newer polled windows and their age when an inactive idle statusline arrives', () => {
    const rateLimits = service()
    const now = Date.now()
    const resetsAt = Math.floor(now / 1000) * 1000 + 600_000
    const window = { usedPercent: 80, windowMinutes: 300, resetsAt, resetDescription: null }
    const newer: ProviderRateLimits = {
      provider: 'claude',
      session: window,
      weekly: { ...window, windowMinutes: 10080 },
      updatedAt: now - 1000,
      status: 'ok',
      error: null
    }
    rateLimits.seedPolledReading('b', newer)
    rateLimits.ingestLiveClaudeRateLimits({
      configDir: HOMES.b,
      fiveHour: { used_percentage: 20, resets_at: resetsAt / 1000 },
      sevenDay: { used_percentage: 80, resets_at: resetsAt / 1000 }
    })
    const reading = rateLimits
      .getState()
      .inactiveClaudeAccounts.find((entry) => entry.accountId === 'b')?.rateLimits
    expect(reading).toBe(newer)
    expect(reading?.updatedAt).toBe(now - 1000)
  })

  it('still drops a post from a folder no managed account owns', () => {
    const rateLimits = service()
    rateLimits.ingestLiveClaudeRateLimits({
      configDir: '/Users/x/.claude',
      fiveHour: { used_percentage: 99 },
      sevenDay: null
    })
    const state = rateLimits.getState()
    expect(state.claude).toBeNull()
    expect(state.inactiveClaudeAccounts).toEqual([])
  })

  it("leaves the selected account's own post on the bar path", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
      mockFreshBackgroundProviderFetches()
      const rateLimits = service()
      rateLimits.setClaudeAuthPreparationResolver(async () => ({
        configDir: HOMES.a,
        // Why: a managed account injects its folder; the auth snapshot reads it from here.
        envPatch: { CLAUDE_CONFIG_DIR: HOMES.a },
        provenance: 'profile:a'
      }))
      await rateLimits.refresh()
      rateLimits.ingestLiveClaudeRateLimits({
        configDir: HOMES.a,
        fiveHour: { used_percentage: 55 },
        sevenDay: { used_percentage: 20 }
      })
      const state = rateLimits.getState()
      expect(state.claude?.session?.usedPercent).toBe(55)
      expect(state.claude?.weekly?.usedPercent).toBe(20)
      expect(state.inactiveClaudeAccounts).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a post that carries neither window', () => {
    const rateLimits = service()
    const listener = vi.fn()
    rateLimits.onStateChange(listener)
    rateLimits.ingestLiveClaudeRateLimits({ configDir: HOMES.b, fiveHour: null, sevenDay: null })
    const state = rateLimits.getState()
    expect(state.inactiveClaudeAccounts.find((usage) => usage.accountId === 'b')).toBeUndefined()
    expect(state.claude).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops the post without throwing when the account resolver throws', () => {
    const rateLimits = new RateLimitService()
    rateLimits.setInactiveClaudeAccountsResolver(() => [{ id: 'b' }, { id: 'c' }])
    rateLimits.setLiveClaudeAccountResolver(() => {
      throw new Error('boom')
    })
    expect(() =>
      rateLimits.ingestLiveClaudeRateLimits({
        configDir: HOMES.b,
        fiveHour: { used_percentage: 99 },
        sevenDay: null
      })
    ).not.toThrow()
    const state = rateLimits.getState()
    expect(state.claude).toBeNull()
    expect(state.inactiveClaudeAccounts).toEqual([])
  })

  it('attributes a proxy-billed post to the assigned account, not the spawn folder', async () => {
    const rateLimits = service()
    rateLimits.ingestLiveClaudeRateLimits({
      configDir: HOMES.a,
      fiveHour: { used_percentage: 97 },
      sevenDay: null,
      billingAccountId: 'b'
    })
    const state = rateLimits.getState()
    expect(state.claude).toBeNull()
    expect(
      state.inactiveClaudeAccounts.find((usage) => usage.accountId === 'b')?.rateLimits?.session
        ?.usedPercent
    ).toBe(97)

    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 18))
    mockFreshBackgroundProviderFetches()
    const selected = service()
    selected.setClaudeAuthPreparationResolver(async () => ({
      configDir: HOMES.a,
      envPatch: { CLAUDE_CONFIG_DIR: HOMES.a },
      provenance: 'profile:a'
    }))
    await selected.refresh()
    selected.ingestLiveClaudeRateLimits({
      configDir: HOMES.b,
      fiveHour: { used_percentage: 44 },
      sevenDay: null,
      billingAccountId: 'a'
    })
    expect(selected.getState().claude?.session?.usedPercent).toBe(44)
    expect(selected.getState().inactiveClaudeAccounts).toEqual([])
  })
})
