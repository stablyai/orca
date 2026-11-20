import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { parseClaudeStatusLineBody } from '../../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'
import {
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))
vi.mock('../providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))
vi.mock('../providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))
vi.mock('../providers/minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

const NOW = Date.parse('2026-03-02T10:00:00Z')
const SESSION_RESET_S = Math.floor((NOW + 3 * 60 * 60 * 1000) / 1000)
const WEEKLY_RESET_S = Math.floor((NOW + 4 * 24 * 60 * 60 * 1000) / 1000)

describe('RateLimitService live Claude usage after a limit reset', () => {
  let service: RateLimitService

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 40))
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
  const usage = async () => {
    const claude = (await service.getState()).claude
    return [claude?.session?.usedPercent, claude?.weekly?.usedPercent]
  }

  it('accepts a lower same-window value once the reporting pane itself changed', async () => {
    post('tab-1:pane-a', 90, 95)
    post('tab-1:pane-a', 100, 100)
    expect(await usage()).toEqual([100, 100])

    // The limit reset keeps resets_at; only this pane's new API response proves the drop.
    post('tab-1:pane-a', 7, 7)
    expect(await usage()).toEqual([7, 7])
  })

  it('keeps a fresh value against first posts and unchanged repeats within its window', async () => {
    post('tab-1:pane-a', 100, 100)
    post('tab-2:pane-b', 100, 100)
    post('tab-1:pane-a', 7, 7)
    expect(await usage()).toEqual([7, 7])

    post('tab-2:pane-b', 100, 100)
    post('tab-3:pane-c', 3, 3)
    post('tab-3:pane-c', 3, 3)
    expect(await usage()).toEqual([7, 7])

    post('tab-2:pane-b', 9, 8)
    expect(await usage()).toEqual([9, 8])
    post('tab-1:pane-a', 7, 7)
    post('tab-5:pane-e', 20, 20)
    expect(await usage()).toEqual([9, 8])

    // A first post may still open a newer window.
    post('tab-4:pane-d', 9, 1, WEEKLY_RESET_S + 7 * 24 * 60 * 60)
    expect(await usage()).toEqual([9, 1])
  })

  it('keeps dropping unproven lower values and older reset windows', async () => {
    post('tab-1:pane-a', 60, 60)
    post('tab-2:pane-b', 50, 50)
    post('tab-2:pane-b', 50, 50)
    post(null, 40, 40)
    expect(await usage()).toEqual([60, 60])

    post('tab-1:pane-a', 60, 30, WEEKLY_RESET_S - 7 * 24 * 60 * 60)
    expect(await usage()).toEqual([60, 60])
  })

  it('reads the reporting pane from the statusline form body', async () => {
    const postForm = (session: number, paneKey?: string) => {
      const event = parseClaudeStatusLineBody({
        payload: JSON.stringify({
          rate_limits: { five_hour: { used_percentage: session, resets_at: SESSION_RESET_S } }
        }),
        ...(paneKey === undefined ? {} : { paneKey })
      })
      expect(event).not.toBeNull()
      if (event) {
        service.ingestLiveClaudeRateLimits(event)
      }
      return event
    }

    postForm(100, '  tab-1:pane-a  ')
    expect(postForm(7, 'tab-1:pane-a')?.paneKey).toBe('tab-1:pane-a')
    expect((await usage())[0]).toBe(7)
    expect(postForm(3)?.paneKey).toBeNull()
    expect((await usage())[0]).toBe(7)
  })
})
