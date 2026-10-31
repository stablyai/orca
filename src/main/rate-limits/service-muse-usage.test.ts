import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchMuseRateLimits } from './muse-usage-fetcher'
import { parseMuseUsageStdout } from './muse-usage-response'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  asRateLimitWindow,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider,
  deferred,
  flushMicrotasks
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

vi.mock('./muse-usage-fetcher', () => ({ fetchMuseRateLimits: vi.fn() }))

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

function museReading(allowance: unknown): ProviderRateLimits {
  const reading = parseMuseUsageStdout(JSON.stringify({ schemaVersion: 1, allowance }), Date.now())
  if (!reading) {
    throw new Error('Invalid test allowance')
  }
  return reading
}

describe('Muse quota polling', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 42))
  })

  it('publishes healthy providers before a slow Muse read and isolates its failure', async () => {
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchMuseRateLimits).mockReturnValue(pending.promise)
    const service = new RateLimitService()
    const refresh = service.refresh()

    await flushMicrotasks(30)
    expect(service.getState().gemini?.session?.usedPercent).toBe(42)
    expect(service.getState().muse?.status).toBe('fetching')
    pending.resolve(errorProvider('muse', 'Muse quota server unavailable'))
    await refresh

    expect(service.getState().muse).toMatchObject({ status: 'error', session: null })
    expect(service.getState().claude?.session?.usedPercent).toBe(7)
    expect(service.getState().codex?.session?.usedPercent).toBe(20)
  })

  it('settles a rejected Muse read without discarding other provider readings', async () => {
    vi.mocked(fetchMuseRateLimits).mockRejectedValueOnce(new Error('Muse process unavailable'))
    const state = await new RateLimitService().refresh()

    expect(state.muse).toMatchObject({ status: 'error', error: 'Muse process unavailable' })
    expect(state.gemini?.session?.usedPercent).toBe(42)
  })

  it('retains a recent reading for a transient error, then clears it for an explicit null allowance', async () => {
    vi.mocked(fetchMuseRateLimits)
      .mockResolvedValueOnce(
        museReading({ window: { usedPercent: 35, resetsAtMs: Date.now() + 60_000 } })
      )
      .mockResolvedValueOnce(errorProvider('muse', 'Temporary network failure'))
      .mockResolvedValueOnce(museReading(null))
    const service = new RateLimitService()

    const first = await service.refresh()
    const failed = await service.refresh()
    expect(failed.muse).toMatchObject({
      status: 'error',
      session: { usedPercent: 35 },
      updatedAt: first.muse?.updatedAt
    })
    const unavailable = await service.refresh()
    expect(unavailable.muse).toMatchObject({
      status: 'unavailable',
      session: null,
      weekly: null,
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
  })

  it('skips hidden meters and preserves the last reading while hidden', async () => {
    const service = new RateLimitService()
    let enabled = false
    service.setMuseUsageEnabledResolver(() => enabled)
    const hidden = await service.refresh()
    expect(hidden.muse).toMatchObject({ status: 'idle', session: null })
    expect(fetchMuseRateLimits).not.toHaveBeenCalled()

    enabled = true
    vi.mocked(fetchMuseRateLimits).mockResolvedValue(museReading({ window: { usedPercent: 35 } }))
    const shown = await service.refresh()
    enabled = false
    vi.mocked(fetchMuseRateLimits).mockResolvedValue(unavailableProvider('muse'))
    const hiddenAgain = await service.refresh()

    expect(shown.muse?.session?.usedPercent).toBe(35)
    expect(hiddenAgain.muse).toEqual(shown.muse)
    expect(fetchMuseRateLimits).toHaveBeenCalledTimes(1)
  })

  it('honors the automated retry gate while allowing a forced refresh', async () => {
    const service = new RateLimitService()
    const failure = {
      ...unavailableProvider('muse'),
      updatedAt: Date.now() - 600_000,
      usageMetadata: { retryAtMs: Date.now() + 60_000 }
    }
    vi.mocked(fetchMuseRateLimits)
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(museReading({ window: { usedPercent: 25 } }))
    // Another provider's stale snapshot triggers a full automated cycle.
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      okProvider('gemini', 42, Date.now() - 600_000)
    )
    await service.refresh()
    await service.refreshIfStale()
    expect(fetchMuseRateLimits).toHaveBeenCalledTimes(1)
    expect(service.getState().muse).toMatchObject(failure)
    await service.refresh()
    expect(fetchMuseRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().muse?.session?.usedPercent).toBe(25)
  })

  it('does not refresh other fresh providers on repeated focus while Muse is disabled', async () => {
    vi.useFakeTimers()
    const service = new RateLimitService()
    try {
      mockFreshBackgroundProviderFetches()
      service.setMuseUsageEnabledResolver(() => false)
      await service.refresh()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      for (let attempt = 0; attempt < 3; attempt += 1) {
        window.emit('focus')
        await flushMicrotasks(30)
      }

      expect(fetchMuseRateLimits).not.toHaveBeenCalled()
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
      expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
      expect(service.getState().muse?.status).toBe('idle')
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })
})
