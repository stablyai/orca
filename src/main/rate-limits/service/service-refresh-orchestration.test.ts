import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import {
  asRateLimitWindow,
  deferred,
  errorProvider,
  FakeRateLimitWindow,
  flushMicrotasks,
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

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('../providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('RateLimitService', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0, 1_000))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0, 1_000))
  })

  it('reads the account picked by a second switch made during a refresh', async () => {
    const service = new RateLimitService()
    const reads = [deferred<ProviderRateLimits>(), deferred<ProviderRateLimits>()]
    vi.mocked(fetchActiveClaudeRateLimits)
      .mockReturnValueOnce(reads[0].promise)
      .mockReturnValueOnce(reads[1].promise)
      .mockResolvedValueOnce(okProvider('claude', 55))
    void service.refresh()
    await flushMicrotasks(20)
    void service.refreshForClaudeAccountChange('acct-a')
    reads[0].resolve(okProvider('claude', 0))
    await flushMicrotasks(40)
    // The first switch's rerun is reading when the user switches again.
    void service.refreshForClaudeAccountChange('acct-b')
    reads[1].resolve(okProvider('claude', 11))
    await flushMicrotasks(60)
    expect(service.getState().claude?.session?.usedPercent).toBe(55)
  })

  it('retries an expired Claude token on its backoff while the window stays focused', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchActiveClaudeRateLimits)
        .mockResolvedValueOnce({
          ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
          usageMetadata: { failureKind: 'stale-token' }
        })
        .mockResolvedValue(okProvider('claude', 12))
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
      service.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(service.getState().claude?.status).toBe('error')

      await vi.advanceTimersByTimeAsync(30 * 1000)

      expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(2)
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().claude?.status).toBe('ok')
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an expired Claude token to activation while the window is unfocused', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue({
        ...errorProvider('claude', 'Claude usage updates the next time Claude runs.'),
        usageMetadata: { failureKind: 'stale-token' }
      })
      mockFreshBackgroundProviderFetches()

      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      window.focused = false
      service.attach(asRateLimitWindow(window))
      service.start()
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

      expect(fetchActiveClaudeRateLimits).toHaveBeenCalledTimes(1)
      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
