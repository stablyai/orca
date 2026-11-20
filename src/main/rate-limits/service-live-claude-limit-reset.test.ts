import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import {
  mockFreshBackgroundProviderFetches,
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
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))

const NOW = Date.parse('2026-03-02T10:00:00Z')
const SESSION_RESET_S = Math.floor((NOW + 3 * 60 * 60 * 1000) / 1000)
const WEEKLY_RESET_S = Math.floor((NOW + 4 * 24 * 60 * 60 * 1000) / 1000)

describe('RateLimitService live Claude usage after a limit reset', () => {
  let service: RateLimitService

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 40))
    mockFreshBackgroundProviderFetches()
    service = new RateLimitService()
    await service.refresh()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const post = (
    paneKey: string | null,
    session: number,
    weekly: number,
    weeklyResetS = WEEKLY_RESET_S
  ) =>
    service.ingestLiveClaudeRateLimits({
      configDir: null,
      paneKey,
      fiveHour: { used_percentage: session, resets_at: SESSION_RESET_S },
      sevenDay: { used_percentage: weekly, resets_at: weeklyResetS }
    })
  const usage = () => {
    const claude = service.getState().claude
    return [claude?.session?.usedPercent, claude?.weekly?.usedPercent]
  }

  it('accepts a lower same-window value once the reporting pane itself changed', () => {
    post('tab-1:pane-a', 90, 95)
    post('tab-1:pane-a', 100, 100)
    expect(usage()).toEqual([100, 100])

    // The limit reset keeps resets_at; only this pane's new API response proves the drop.
    post('tab-1:pane-a', 7, 7)
    expect(usage()).toEqual([7, 7])
  })

  it('keeps a fresh value against first posts and unchanged repeats within its window', () => {
    post('tab-1:pane-a', 100, 100)
    post('tab-2:pane-b', 100, 100)
    post('tab-1:pane-a', 7, 7)
    expect(usage()).toEqual([7, 7])

    post('tab-2:pane-b', 100, 100)
    post('tab-3:pane-c', 3, 3)
    post('tab-3:pane-c', 3, 3)
    expect(usage()).toEqual([7, 7])

    post('tab-2:pane-b', 9, 8)
    expect(usage()).toEqual([9, 8])
    post('tab-1:pane-a', 7, 7)
    post('tab-5:pane-e', 20, 20)
    expect(usage()).toEqual([9, 8])

    // A first post may still open a newer window.
    post('tab-4:pane-d', 9, 1, WEEKLY_RESET_S + 7 * 24 * 60 * 60)
    expect(usage()).toEqual([9, 1])
  })

  it('keeps dropping unproven lower values and older reset windows', () => {
    post('tab-1:pane-a', 60, 60)
    post('tab-2:pane-b', 50, 50)
    post('tab-2:pane-b', 50, 50)
    post(null, 40, 40)
    expect(usage()).toEqual([60, 60])

    post('tab-1:pane-a', 60, 30, WEEKLY_RESET_S - 7 * 24 * 60 * 60)
    expect(usage()).toEqual([60, 60])
  })
})
