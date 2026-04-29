/* eslint-disable max-lines -- Why: these tests mirror the fetch ordering,
stale-data handling, account-switch generation, and OpenCode config-change
semantics covered in service.ts, which already carries the same pragma.
Keeping them in one file makes the ordering contract reviewable as a unit. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
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
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
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

function errorProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
  message: string
): ProviderRateLimits {
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
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(okProvider('opencode-go', 0, Date.now()))
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

  it('fetches Gemini and OpenCode Go alongside Claude and Codex', async () => {
    const service = new RateLimitService()
    service.setSettingsResolver(() => ({
      opencodeSessionCookie: 'session=abc123',
      opencodeWorkspaceId: ''
    }))

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledWith('session=abc123', undefined)

    const state = service.getState()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
    expect(state.codex?.status).toBe('ok')
    expect(state.codex?.session?.usedPercent).toBe(20)
    expect(state.gemini?.status).toBe('ok')
    expect(state.gemini?.session?.usedPercent).toBe(30)
    expect(state.opencodeGo?.status).toBe('ok')
    expect(state.opencodeGo?.session?.usedPercent).toBe(40)
  })

  it('preserves Gemini buckets through getState after fetch', async () => {
    const service = new RateLimitService()

    const geminiWithBuckets: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(geminiWithBuckets)
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 0, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.buckets).toHaveLength(2)
    expect(state.gemini?.buckets![0].name).toBe('Pro')
    expect(state.gemini?.buckets![1].name).toBe('Flash')
    // Why: session summary is derived from bucket data and must match the most constrained bucket.
    expect(state.gemini?.session?.usedPercent).toBe(80)
  })

  it('isolates provider failures so one error does not block others', async () => {
    const service = new RateLimitService()
    service.setSettingsResolver(() => ({ opencodeSessionCookie: '', opencodeWorkspaceId: '' }))

    vi.mocked(fetchClaudeRateLimits).mockRejectedValueOnce(new Error('claude down'))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockRejectedValueOnce(new Error('gemini down'))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.error).toBe('claude down')
    expect(state.codex?.status).toBe('ok')
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('gemini down')
    expect(state.opencodeGo?.status).toBe('ok')
  })

  it('discards stale data when a provider becomes unavailable', async () => {
    const service = new RateLimitService()
    let cookie = 'session=valid'
    service.setSettingsResolver(() => ({ opencodeSessionCookie: cookie, opencodeWorkspaceId: '' }))

    // 1. Success fetch
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Clear cookie -> should become unavailable and LOSE the 40% data
    cookie = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'Session cookie not configured',
      status: 'unavailable'
    })

    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('unavailable')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('Session cookie not configured')
  })

  it('discards stale data when Workspace ID override is changed', async () => {
    const service = new RateLimitService()
    let workspaceId = 'wrk_A'
    service.setSettingsResolver(() => ({
      opencodeSessionCookie: 'session=valid',
      opencodeWorkspaceId: workspaceId
    }))

    // 1. Success fetch for Workspace A
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Change Workspace ID to B -> old data from A should be discarded
    workspaceId = 'wrk_B'
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 10, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(10)

    // 3. Clear Workspace ID (automatic) but it fails -> should show error, NOT stale data from B
    workspaceId = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
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
})
