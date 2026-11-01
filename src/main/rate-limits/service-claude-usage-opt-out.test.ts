import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
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

vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
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

describe('RateLimitService Claude usage opt-out', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 25))
    vi.mocked(fetchManagedAccountUsage).mockResolvedValue(okProvider('claude', 30))
  })

  it('never calls Claude usage endpoint when Claude usage is disabled', async () => {
    const service = new RateLimitService()
    service.setClaudeUsageEnabledResolver(() => false)

    await service.refresh()

    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('idle')
    expect(service.getState().gemini?.status).toBe('ok')
  })

  it('calls Claude usage endpoint when Claude usage is enabled', async () => {
    const service = new RateLimitService()
    service.setClaudeUsageEnabledResolver(() => true)

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('does not bypass disabled Claude usage setting on manual force refresh', async () => {
    const service = new RateLimitService()
    service.setClaudeUsageEnabledResolver(() => false)

    await service.refresh()

    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(service.getState().claude?.status).toBe('idle')
  })

  it('preserves existing Claude usage snapshot without making network requests when disabled mid-session', async () => {
    const service = new RateLimitService()
    let enabled = true
    service.setClaudeUsageEnabledResolver(() => enabled)

    await service.refresh()
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.session?.usedPercent).toBe(25)

    // Disable mid-session
    enabled = false
    await service.refresh()

    // No additional fetch should occur, and existing usage remains intact
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().claude?.session?.usedPercent).toBe(25)
  })

  it('skips inactive Claude accounts fetch when Claude usage is disabled', async () => {
    const service = new RateLimitService()
    service.setClaudeUsageEnabledResolver(() => false)
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'acc-1', managedAuthRuntime: 'host', wslDistro: null, wslLinuxAuthPath: null }
    ])

    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchManagedAccountUsage).not.toHaveBeenCalled()
  })

  it('fetches inactive Claude accounts when Claude usage is enabled', async () => {
    const service = new RateLimitService()
    service.setClaudeUsageEnabledResolver(() => true)
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'acc-1', managedAuthRuntime: 'host', wslDistro: null, wslLinuxAuthPath: null }
    ])

    await service.fetchInactiveClaudeAccountsOnOpen()

    expect(fetchManagedAccountUsage).toHaveBeenCalledTimes(1)
  })
})
