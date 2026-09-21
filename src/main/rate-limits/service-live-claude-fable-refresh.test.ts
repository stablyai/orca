import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import {
  asRateLimitWindow,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  errorProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn()
}))
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-fetcher', () => ({ fetchOpenCodeGoRateLimits: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))

describe('Fable refresh during continuous Claude activity', () => {
  let service: RateLimitService

  beforeEach(() => {
    vi.useFakeTimers()
    resetRateLimitProviderMocks()
    mockFreshBackgroundProviderFetches()
    service = new RateLimitService()
    service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  function quota(fable: number) {
    return {
      ...okProvider('claude', 75),
      fableWeekly: {
        usedPercent: fable,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      }
    }
  }

  async function keepLive(minutes: number): Promise<void> {
    for (let minute = 0; minute < minutes; minute += 1) {
      service.ingestLiveClaudeRateLimits({
        configDir: null,
        fiveHour: { used_percentage: 75 },
        sevenDay: { used_percentage: 30 }
      })
      await vi.advanceTimersByTimeAsync(60_000)
    }
  }

  it('refreshes 18% to 39% on the polling cadence despite a fresh statusline every minute', async () => {
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(async () => quota(18))
      .mockImplementation(async () => quota(39))
    await service.refresh()
    service.start({ fetchImmediately: false })

    await keepLive(14)
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(18)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    await keepLive(1)
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(39)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    await keepLive(14)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
  })

  it('keeps successive scheduled refreshes on cadence when responses take time', async () => {
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(async () => quota(18))
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return quota(39)
      })
    await service.refresh()
    service.start({ fetchImmediately: false })
    await keepLive(15)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    await keepLive(15)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
    await keepLive(15)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(4)
  })

  it('does not let live posts erase Retry-After for supplemental refreshes', async () => {
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(async () => quota(18))
      .mockImplementationOnce(async () => ({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60_000, failureKind: 'rate-limited' }
      }))
      .mockImplementation(async () => quota(39))
    await service.refresh()
    service.start({ fetchImmediately: false })

    await keepLive(15)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    await keepLive(59)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().claude?.session?.usedPercent).toBe(75)
    await keepLive(1)
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(39)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
  })

  it('discovers a Fable window missing from the initial response without waiting for Claude to idle', async () => {
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(async () => okProvider('claude', 75))
      .mockImplementation(async () => quota(39))
    await service.refresh()
    service.start({ fetchImmediately: false })
    await keepLive(15)
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(39)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
  })

  it('does not carry the outgoing account retry delay into the incoming account', async () => {
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(async () => ({
        ...errorProvider('claude', 'rate limited'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60_000, failureKind: 'rate-limited' }
      }))
      .mockImplementationOnce(async () => quota(4))
      .mockImplementation(async () => quota(9))
    await service.refresh()
    await service.refreshForClaudeAccountChange('outgoing')
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(4)
    service.start({ fetchImmediately: false })
    await keepLive(15)
    expect(service.getState().claude?.fableWeekly?.usedPercent).toBe(9)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(3)
  })
})
