import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  asRateLimitWindow,
  errorProvider,
  FakeRateLimitWindow,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
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

vi.mock('./muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

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

describe('RateLimitService Antigravity runtime switching', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
  })

  it('drops stale usage when the default distro resolves to a different runtime', async () => {
    const withRuntime = (result: ProviderRateLimits, runtime: string): ProviderRateLimits => ({
      ...result,
      usageMetadata: { ...result.usageMetadata, authProvenance: runtime }
    })
    vi.mocked(fetchAntigravityRateLimits)
      .mockResolvedValueOnce(withRuntime(okProvider('antigravity', 30), 'wsl:ubuntu'))
      .mockResolvedValueOnce(withRuntime(errorProvider('antigravity', 'timed out'), 'wsl:debian'))
    const service = new RateLimitService()
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: null })

    await service.refresh()
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('error')
    expect(service.getState().antigravity?.session).toBeNull()
  })

  it.each([false, true])(
    'discards an outgoing read even after switching back: %s',
    async (switchBack) => {
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProviderRateLimits>()
      vi.mocked(fetchAntigravityRateLimits).mockImplementationOnce(() => {
        started.resolve()
        return pending.promise
      })
      const service = new RateLimitService()
      const refresh = service.refresh()
      await started.promise

      service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      if (switchBack) {
        service.setAntigravityFetchTarget({ runtime: 'host', wslDistro: null })
      }
      pending.resolve(okProvider('antigravity', 30))
      await refresh

      expect(service.getState().antigravity).toBeNull()
    }
  )

  it('drops the old runtime cooldown before an automated refresh', async () => {
    vi.mocked(fetchAntigravityRateLimits)
      .mockResolvedValueOnce({
        ...unavailableProvider('antigravity', 'Sign in with agy'),
        usageMetadata: { retryAtMs: Date.now() + 60 * 60 * 1000 }
      })
      .mockResolvedValue(okProvider('antigravity', 30))
    const service = new RateLimitService()
    await service.refresh()

    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await service.refreshIfStale()

    expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().antigravity?.session?.usedPercent).toBe(30)
  })
})

describe('Antigravity usage gating', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  })

  it('holds browser sign-in reads until a credential change or refresh', async () => {
    vi.useFakeTimers()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
      const signInRequired = async () => ({
        ...unavailableProvider('antigravity', 'Sign in with `agy`'),
        usageMetadata: {
          failureKind: 'missing-credentials' as const,
          retryAtMs: Number.MAX_SAFE_INTEGER
        }
      })
      vi.mocked(fetchAntigravityRateLimits)
        .mockImplementationOnce(signInRequired)
        .mockImplementationOnce(signInRequired)
        .mockImplementation(async () => okProvider('antigravity', 30))
      const service = new RateLimitService()
      const window = new FakeRateLimitWindow()
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: false })

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      // Why: each automated read would open another browser sign-in page (#26484).
      window.emit('focus')
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(vi.mocked(fetchCodexRateLimits).mock.calls.length).toBeGreaterThan(1)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)

      service.invalidateAntigravityCredentialState()
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)

      await service.refresh()
      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getState().antigravity?.status).toBe('ok')

      service.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['held', 'sign-in', 'usage'] as const)(
    'preserves a credential change during the %s background cycle',
    async (phase) => {
      vi.useFakeTimers()
      const service = new RateLimitService()
      try {
        mockFreshBackgroundProviderFetches()
        const signInRequired: ProviderRateLimits = {
          ...unavailableProvider('antigravity'),
          usageMetadata: {
            failureKind: 'missing-credentials',
            retryAtMs: Number.MAX_SAFE_INTEGER
          }
        }
        vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(signInRequired)
        if (phase === 'held') {
          await service.refresh()
        }
        const pending = Promise.withResolvers<ProviderRateLimits>()
        if (phase === 'held') {
          vi.mocked(fetchClaudeRateLimits).mockReturnValueOnce(pending.promise)
        } else {
          vi.mocked(fetchAntigravityRateLimits).mockReturnValueOnce(pending.promise)
        }
        service.attach(asRateLimitWindow(new FakeRateLimitWindow()))
        service.start()
        await vi.advanceTimersByTimeAsync(0)
        expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(1)
        expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(phase === 'held' ? 2 : 1)

        service.invalidateAntigravityCredentialState()
        pending.resolve(
          phase === 'held'
            ? okProvider('claude', 7)
            : phase === 'usage'
              ? okProvider('antigravity', 30)
              : signInRequired
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(service.getState().antigravity).toBeNull()

        vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 60))
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
        expect(service.getState().antigravity?.session?.usedPercent).toBe(60)
      } finally {
        service.stop()
        vi.useRealTimers()
      }
    }
  )

  it('uses the released hold when credentials change during asynchronous cycle preparation', async () => {
    vi.useFakeTimers()
    const service = new RateLimitService()
    try {
      mockFreshBackgroundProviderFetches()
      vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
        ...unavailableProvider('antigravity'),
        usageMetadata: { retryAtMs: Number.MAX_SAFE_INTEGER }
      })
      await service.refresh()
      service.setCodexHomePathResolver(
        vi
          .fn()
          .mockResolvedValue(null)
          .mockImplementationOnce(async () => {
            service.invalidateAntigravityCredentialState()
            return null
          })
      )
      vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 60))

      service.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchAntigravityRateLimits).toHaveBeenCalledTimes(2)
      expect(service.getState().antigravity?.session?.usedPercent).toBe(60)
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })
})

describe('Antigravity account attribution', () => {
  const login = { key: 'consumer\na', accountId: 'a', email: 'a@example.invalid' }
  const saved = (rateLimits: ProviderRateLimits | null) => [
    { accountId: 'a', email: 'a@example.invalid', active: true, rateLimits },
    { accountId: 'b', email: 'b@example.invalid', active: false, rateLimits: null }
  ]

  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(okProvider('antigravity', 30))
  })

  it('names the saved account a reading belongs to and lists every saved account', async () => {
    const service = new RateLimitService()
    service.setAntigravityFetchTarget({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    const begin = vi.fn(async () => ({ login, accounts: saved(null) }))
    const finish = vi.fn(async (_target: unknown, _login: unknown, limits: ProviderRateLimits) => ({
      switched: false as const,
      account: { id: 'a', email: 'a@example.invalid' },
      accounts: saved(limits)
    }))
    service.setAntigravityAccountUsageRecorder({ begin, finish })

    await service.refresh()

    const state = service.getState()
    expect(begin).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(finish).toHaveBeenCalledWith(
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      login,
      expect.anything()
    )
    expect(state.antigravity?.usageMetadata?.account).toEqual({
      id: 'a',
      email: 'a@example.invalid'
    })
    expect(
      state.antigravityAccounts.map((entry) => entry.rateLimits?.session?.usedPercent ?? null)
    ).toEqual([30, null])
  })

  it('discards a reading when the agy login changed during the read', async () => {
    const service = new RateLimitService()
    service.setAntigravityAccountUsageRecorder({
      begin: async () => ({ login, accounts: saved(null) }),
      finish: async () => ({ switched: true })
    })

    await service.refresh()

    expect(service.getState().antigravity).toBeNull()
    expect(service.getState().antigravityAccounts.every((entry) => !entry.rateLimits)).toBe(true)
  })
})
