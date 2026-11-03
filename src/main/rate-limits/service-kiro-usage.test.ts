import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchKiroRateLimits } from './kiro-usage-fetcher'
import {
  errorProvider,
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
vi.mock('./antigravity-usage-fetcher', () => ({ fetchAntigravityRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./kiro-usage-fetcher', () => ({ fetchKiroRateLimits: vi.fn() }))
vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn(),
  hasZcodeCliPlanCredentials: vi.fn(() => false)
}))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))
vi.mock('../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: vi.fn(() => false) }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({
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
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
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
