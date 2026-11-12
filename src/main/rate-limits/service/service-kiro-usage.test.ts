import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchKiroRateLimits } from '../providers/kiro/kiro-usage-fetcher'
import {
  errorProvider,
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
vi.mock('../providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/kiro/kiro-usage-fetcher', () => ({ fetchKiroRateLimits: vi.fn() }))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn(),
  hasZcodeCliPlanCredentials: vi.fn(() => false)
}))
vi.mock('../providers/minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: vi.fn(() => false) }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: vi.fn(() => false),
  readZcodePlanApiKey: vi.fn(() => null),
  saveZcodePlanApiKey: vi.fn(),
  clearZcodePlanApiKey: vi.fn()
}))

function kiroReading(usedPercent: number, account: string): ProviderRateLimits {
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly: { usedPercent, windowMinutes: 43_200, resetsAt: null, resetDescription: null },
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'oauth', authProvenance: account }
  }
}

function kiroFailure(account: string): ProviderRateLimits {
  return {
    ...errorProvider('kiro', 'Kiro usage request failed (500)'),
    usageMetadata: { source: 'oauth', failureKind: 'server', authProvenance: account }
  }
}

describe('RateLimitService Kiro usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('does not call kiro-cli usage while the meter is hidden, and still settles the slot', async () => {
    const service = new RateLimitService()
    service.setKiroUsageEnabledResolver(() => false)

    await service.refresh()

    expect(fetchKiroRateLimits).not.toHaveBeenCalled()
    // A null slot would read as "still loading" and block the empty-usage state.
    expect(service.getState().kiro).toMatchObject({ provider: 'kiro', status: 'unavailable' })
  })

  it('applies a reading once the meter is shown', async () => {
    let enabled = false
    const service = new RateLimitService()
    service.setKiroUsageEnabledResolver(() => enabled)
    vi.mocked(fetchKiroRateLimits).mockResolvedValue(kiroReading(34, 'account-a'))

    await service.refresh()
    enabled = true
    await service.refresh()

    expect(fetchKiroRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().kiro?.monthly?.usedPercent).toBe(34)
  })

  it('keeps the same account reading through a transient failure', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchKiroRateLimits)
      .mockResolvedValueOnce(kiroReading(34, 'account-a'))
      .mockResolvedValueOnce(kiroFailure('account-a'))

    await service.refresh()
    await service.refresh()

    const kiro = service.getState().kiro
    expect(kiro?.status).toBe('error')
    expect(kiro?.monthly?.usedPercent).toBe(34)
  })

  it('drops the old reading when kiro-cli switched to another account', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchKiroRateLimits)
      .mockResolvedValueOnce(kiroReading(34, 'account-a'))
      .mockResolvedValueOnce(kiroFailure('account-b'))

    await service.refresh()
    await service.refresh()

    const kiro = service.getState().kiro
    expect(kiro?.status).toBe('error')
    expect(kiro?.monthly ?? null).toBeNull()
  })
})
