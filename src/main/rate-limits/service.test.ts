import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn()
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function okProvider(
  provider: 'claude' | 'codex',
  usedPercent: number,
  updatedAt = Date.now()
): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function errorProvider(provider: 'claude' | 'codex', message: string): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'error'
  }
}

function serviceInternals(service: RateLimitService): { fetchAll: () => Promise<void> } {
  return service as unknown as { fetchAll: () => Promise<void> }
}

describe('RateLimitService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not refetch Claude when a Codex account switch is queued during fetchAll', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => firstClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockResolvedValueOnce(okProvider('codex', 42))

    const fullRefresh = service.refresh()
    await Promise.resolve()

    const switchRefresh = service.refreshForCodexAccountChange()
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 18))
    firstCodex.resolve(okProvider('codex', 24))

    await fullRefresh
    await switchRefresh

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('keeps recent stale data across repeated failures', async () => {
    const service = new RateLimitService()
    const internal = serviceInternals(service)

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 33, Date.now()))
      .mockResolvedValueOnce(errorProvider('claude', 'temporary failure'))
      .mockResolvedValueOnce(errorProvider('claude', 'still failing'))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))

    await internal.fetchAll()
    await internal.fetchAll()

    let state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)

    await internal.fetchAll()

    state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)
    expect(state.claude?.error).toBe('still failing')
  })

  it('bypasses the debounce for explicit manual refreshes', async () => {
    const service = new RateLimitService()

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
      .mockResolvedValueOnce(okProvider('claude', 11, Date.now()))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 21, Date.now()))

    await service.refresh()
    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('waits for a queued explicit refresh when another fetch is already in flight', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()
    const secondClaude = deferred<ProviderRateLimits>()
    const secondCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(() => firstClaude.promise)
      .mockImplementationOnce(() => secondClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockImplementationOnce(() => secondCodex.promise)

    const backgroundFetch = serviceInternals(service).fetchAll()
    await Promise.resolve()

    let refreshResolved = false
    const manualRefresh = service.refresh().then(() => {
      refreshResolved = true
    })
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 10, Date.now()))
    firstCodex.resolve(okProvider('codex', 20, Date.now()))
    await Promise.resolve()

    expect(refreshResolved).toBe(false)

    secondClaude.resolve(okProvider('claude', 11, Date.now()))
    secondCodex.resolve(okProvider('codex', 21, Date.now()))
    await backgroundFetch
    await manualRefresh

    expect(refreshResolved).toBe(true)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })
})
