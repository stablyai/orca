import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchZcodeRateLimits } from '../providers/zcode/zcode-usage-fetcher'
import { fetchOpenCodeGoUsage } from '../providers/opencode-go/opencode-go-usage-source-selection'
import { fetchGrokRateLimits } from '../providers/grok/grok-fetcher'
import { readGrokAuthSession } from '../providers/grok/grok-auth'
import { GROK_ACCESS_TOKEN_REFRESH_LEAD_MS } from '../providers/grok/grok-auth-expiry'
import {
  errorProvider,
  flushMicrotasks,
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

  it('does not keep a previous ZCode account quota after a failed account switch', async () => {
    vi.mocked(fetchZcodeRateLimits)
      .mockResolvedValueOnce({
        ...okProvider('zcode', 42),
        usageMetadata: { source: 'web', authProvenance: 'account-a' }
      })
      .mockResolvedValueOnce({
        ...errorProvider('zcode', 'request failed'),
        usageMetadata: { source: 'web', authProvenance: 'account-b', failureKind: 'network' }
      })
    const service = new RateLimitService()

    await service.refresh()
    await service.refresh()

    expect(service.getState().zcode?.status).toBe('error')
    expect(service.getState().zcode?.session).toBeNull()
  })

  it('discards stale data when Workspace ID override is changed', async () => {
    const service = new RateLimitService()
    let workspaceId = 'wrk_A'
    service.setOpenCodeGoConfigResolver(() => ({
      sessionCookie: 'session=valid',
      workspaceIdOverride: workspaceId
    }))

    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 40, Date.now()))
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    workspaceId = 'wrk_B'
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 10, Date.now()))
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(10)

    // Switching to automatic mode must discard workspace B's data even if the first refresh fails.
    workspaceId = ''
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No workspace ID found',
      status: 'error'
    })
    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('No workspace ID found')
  })

  it('keeps automatic usage readings inside a failing provider backoff', async () => {
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(errorProvider('codex', 'probe failed'))
    const service = new RateLimitService()
    service.requestUsageReading('codex')
    await flushMicrotasks(20)
    expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(1)
    // That failure starts the backoff the poller keeps; an automatic read waits it out.
    service.requestUsageReading('codex')
    await flushMicrotasks(20)
    expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(1)
  })

  it('admits an automatic read for the account selected after a switch, both ways', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = 1_000_000
      let home = '/accounts/default/.codex'
      const service = new RateLimitService()
      service.setCodexHomePathResolver(() => ({ kind: 'ready', codexHomePath: home }))
      vi.mocked(fetchCodexRateLimits).mockClear()
      const automaticRead = async (at: number) => {
        vi.setSystemTime(at)
        vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 10, at))
        service.requestUsageReading('codex', { notWithinMs: 600_000 })
        await flushMicrotasks(20)
      }
      // The other account is selected and its switch-time read fails.
      const switchTo = async (next: string, at: number) => {
        vi.setSystemTime(at)
        home = next
        vi.mocked(fetchCodexRateLimits).mockResolvedValue(errorProvider('codex', 'probe failed'))
        await service.refreshForCodexAccountChange(null)
      }
      await automaticRead(start)
      await switchTo('/accounts/managed-b', start + 60_000)
      // Past the failure backoff and well inside the default account's ten minutes.
      await automaticRead(start + 90_000)
      expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(3)
      await switchTo('/accounts/default/.codex', start + 150_000)
      await automaticRead(start + 180_000)
      expect(vi.mocked(fetchCodexRateLimits)).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rechecks Grok before the access token expires, even without a focused window', async () => {
    vi.useFakeTimers()
    const expiresAtMs = Date.now() + GROK_ACCESS_TOKEN_REFRESH_LEAD_MS + 5_000
    vi.mocked(readGrokAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        accessToken: 'token',
        userId: null,
        email: null,
        teamId: null,
        expiresAtMs,
        oidcClientId: null
      }
    })
    vi.mocked(fetchGrokRateLimits).mockResolvedValue(okProvider('grok', 42))
    const service = new RateLimitService()
    try {
      service.start({ fetchImmediately: false })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(fetchGrokRateLimits).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchGrokRateLimits).toHaveBeenCalledTimes(1)
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })
})
