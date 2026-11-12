import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchKiroRateLimits } from '../providers/kiro/kiro-fetcher'
import {
  deferred,
  unavailableProvider,
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

vi.mock('../providers/kiro/kiro-fetcher', () => ({
  fetchKiroRateLimits: vi.fn()
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

describe('Kiro usage refresh', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
  })

  it('publishes Kiro monthly usage while another provider is still pending', async () => {
    const claude = deferred<ReturnType<typeof okProvider>>()
    vi.mocked(fetchActiveClaudeRateLimits).mockReturnValue(claude.promise)
    vi.mocked(fetchKiroRateLimits).mockResolvedValue({
      ...okProvider('kiro', 0),
      session: null,
      monthly: { usedPercent: 18, windowMinutes: 43200, resetsAt: null, resetDescription: null }
    })
    const service = new RateLimitService()
    const refreshing = service.refresh()
    await flushMicrotasks()
    expect(service.getState().kiro?.monthly?.usedPercent).toBe(18)
    claude.resolve(okProvider('claude', 0))
    await refreshing
  })

  it('keeps recent Kiro usage through a transient failure and clears it on sign-out', async () => {
    vi.mocked(fetchKiroRateLimits)
      .mockResolvedValueOnce({
        ...okProvider('kiro', 0),
        session: null,
        monthly: { usedPercent: 18, windowMinutes: 43200, resetsAt: null, resetDescription: null }
      })
      .mockResolvedValueOnce(errorProvider('kiro', 'Unable to read Kiro usage'))
      .mockResolvedValueOnce(unavailableProvider('kiro', 'Not signed in to Kiro'))
    const service = new RateLimitService()
    await service.refresh()
    await service.refresh()
    expect(service.getState().kiro?.monthly?.usedPercent).toBe(18)
    expect(service.getState().kiro?.status).toBe('error')
    await service.refresh()
    expect(service.getState().kiro?.monthly).toBeUndefined()
    expect(service.getState().kiro?.status).toBe('unavailable')
  })

  it('does not launch Kiro when its status bar meter is hidden', async () => {
    const service = new RateLimitService()
    service.setKiroUsageEnabledResolver(() => false)
    await service.refresh()
    expect(fetchKiroRateLimits).not.toHaveBeenCalled()
    expect(service.getState().kiro?.status).toBe('idle')
  })
})
