import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import {
  deferred,
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

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
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

function resolveOnAbort(signal: AbortSignal | undefined, result: ProviderRateLimits) {
  return new Promise<ProviderRateLimits>((resolve) => {
    signal?.addEventListener('abort', () => resolve(result), { once: true })
  })
}

describe('RateLimitService text subscription refresh', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('keeps a shared refresh running for remaining callers when one caller aborts', async () => {
    const service = new RateLimitService()
    const fetch = deferred<ProviderRateLimits>()
    let fetchSignal: AbortSignal | undefined
    vi.mocked(fetchClaudeRateLimits).mockImplementation((options) => {
      fetchSignal = options?.signal
      return fetch.promise
    })
    const first = new AbortController()
    const second = new AbortController()

    const firstRefresh = service.refreshTextSubscriptionAccounts('claude', first.signal)
    const secondRefresh = service.refreshTextSubscriptionAccounts('claude', second.signal)
    await vi.waitFor(() => expect(fetchClaudeRateLimits).toHaveBeenCalledOnce())
    first.abort()
    await firstRefresh

    expect(fetchSignal?.aborted).toBe(false)
    fetch.resolve(okProvider('claude', 40))
    await secondRefresh

    expect(fetchClaudeRateLimits).toHaveBeenCalledOnce()
    expect(service.getState().claude).toMatchObject({
      status: 'ok',
      session: expect.objectContaining({ usedPercent: 40 })
    })
  })

  it('aborts the shared refresh only after every caller aborts, without writing its result', async () => {
    const service = new RateLimitService()
    let fetchSignal: AbortSignal | undefined
    vi.mocked(fetchClaudeRateLimits).mockImplementationOnce((options) => {
      fetchSignal = options?.signal
      return resolveOnAbort(options?.signal, errorProvider('claude', 'aborted'))
    })
    const first = new AbortController()
    const second = new AbortController()

    const refreshes = [
      service.refreshTextSubscriptionAccounts('claude', first.signal),
      service.refreshTextSubscriptionAccounts('claude', second.signal)
    ]
    await vi.waitFor(() => expect(fetchClaudeRateLimits).toHaveBeenCalledOnce())
    first.abort()
    expect(fetchSignal?.aborted).toBe(false)
    second.abort()
    await Promise.all(refreshes)

    expect(fetchSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(service.getState().claude).toBeNull())

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 12))
    await service.refreshTextSubscriptionAccounts('claude', new AbortController().signal)
    expect(service.getState().claude).toMatchObject({ status: 'ok' })
  })

  it('still runs cycles queued by other callers after the refresh caller aborts', async () => {
    const service = new RateLimitService()
    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce((options) =>
        resolveOnAbort(options?.signal, errorProvider('claude', 'aborted'))
      )
      .mockResolvedValueOnce(okProvider('claude', 55))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 66))
    const caller = new AbortController()

    void service.refreshTextSubscriptionAccounts('claude', caller.signal)
    await vi.waitFor(() => expect(fetchClaudeRateLimits).toHaveBeenCalledOnce())
    const queuedClaude = service.refreshClaudeForTarget()
    const queuedCodex = service.refreshCodexForTarget()
    caller.abort()
    await Promise.all([queuedClaude, queuedCodex])

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchClaudeRateLimits).mock.calls[1]?.[0]?.signal?.aborted).toBe(false)
    expect(service.getState().claude).toMatchObject({
      status: 'ok',
      session: expect.objectContaining({ usedPercent: 55 })
    })
    expect(service.getState().codex).toMatchObject({
      status: 'ok',
      session: expect.objectContaining({ usedPercent: 66 })
    })
  })

  it('keeps cached inactive usage and skips the completion stamp when the caller aborts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    try {
      const service = new RateLimitService()
      service.setInactiveCodexAccountsResolver(() =>
        ['a', 'b'].map((id) => ({
          id,
          resolveHome: () => ({ kind: 'ready' as const, managedHomePath: `/tmp/${id}/home` })
        }))
      )
      vi.mocked(fetchCodexRateLimits).mockImplementation(async (options) =>
        okProvider('codex', options?.codexHomePath === '/tmp/a/home' ? 10 : 20)
      )
      await vi.advanceTimersByTimeAsync(0)
      const seed = service.fetchInactiveCodexAccountsOnOpen()
      await vi.runAllTimersAsync()
      await seed
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      vi.mocked(fetchCodexRateLimits).mockImplementation(
        (options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          })
      )
      const caller = new AbortController()
      const aborted = service.fetchInactiveCodexAccountsOnOpen(caller.signal)
      await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledTimes(3))
      caller.abort()
      await aborted

      expect(service.getState().inactiveCodexAccounts).toEqual([
        expect.objectContaining({
          accountId: 'a',
          isFetching: false,
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 10 })
          })
        }),
        expect.objectContaining({
          accountId: 'b',
          isFetching: false,
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 20 })
          })
        })
      ])

      vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 30))
      const retry = service.fetchInactiveCodexAccountsOnOpen()
      await vi.runAllTimersAsync()
      await retry
      expect(fetchCodexRateLimits).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })
})
