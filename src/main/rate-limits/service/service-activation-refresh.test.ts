import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { fetchKimiRateLimits } from '../providers/kimi/kimi-fetcher'
import { readKimchiUsageAuth } from '../providers/kimchi/kimchi-auth'
import { fetchKimchiRateLimits } from '../providers/kimchi/kimchi-fetcher'
import { RateLimitService } from './rate-limit-service'

const { unavailable } = vi.hoisted(() => ({
  unavailable:
    (provider: ProviderRateLimits['provider']) => async (): Promise<ProviderRateLimits> => ({
      provider,
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'unavailable'
    })
}))

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: unavailable('claude')
}))
vi.mock('../providers/codex/codex-fetcher', () => ({
  fetchCodexRateLimits: unavailable('codex')
}))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: unavailable('opencode-go')
}))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/kimchi/kimchi-auth', () => ({ readKimchiUsageAuth: vi.fn() }))
vi.mock('../providers/kimchi/kimchi-fetcher', () => ({ fetchKimchiRateLimits: vi.fn() }))
vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: unavailable('minimax')
}))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: unavailable('grok') }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: () => ({ status: 'missing' })
}))
vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: unavailable('cursor')
}))
vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: async () => ({ status: 'missing' })
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: unavailable('zcode')
}))
vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: unavailable('muse')
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: async () => false }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: async () => false }))

class TestRateLimitService extends RateLimitService {
  async refreshAutomatically(): Promise<RateLimitState> {
    await this.fetchAll()
    return this.getState()
  }

  publishClaude(limits: ProviderRateLimits): void {
    this.updateState({ ...this.state, claude: limits })
  }
}

beforeEach(() => {
  vi.mocked(readKimchiUsageAuth).mockReset()
  vi.mocked(readKimchiUsageAuth).mockResolvedValue({
    status: 'missing',
    error: 'No Kimchi sign-in'
  })
  vi.mocked(fetchKimchiRateLimits).mockReset()
  vi.mocked(fetchKimchiRateLimits).mockImplementation(unavailable('kimchi'))
})

afterEach(() => {
  vi.useRealTimers()
})

it('publishes local usage without a window activation and limits repeated owner returns', async () => {
  vi.useFakeTimers()
  const start = Date.parse('2026-11-22T12:00:00Z')
  vi.setSystemTime(start)
  let usedPercent = 10
  vi.mocked(fetchKimiRateLimits).mockImplementation(async () => ({
    provider: 'kimi',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }))
  const service = new RateLimitService()
  let published: RateLimitState | undefined
  let focused = true
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => focused,
    webContents: {
      send: (_channel: string, state: RateLimitState) => {
        published = state
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach uses only the window methods above.
  service.attach(window as unknown as BrowserWindow)

  try {
    expect((await service.refresh()).kimi?.session?.usedPercent).toBe(10)

    usedPercent = 60
    vi.setSystemTime(start + 360_000)
    await expect(service.refreshOnOwnerReturn()).resolves.toBeUndefined()
    expect((await service.getState()).kimi?.session?.usedPercent).toBe(60)
    await vi.waitFor(() => expect(published?.kimi?.session?.usedPercent).toBe(60))

    usedPercent = 80
    // An unwatched return stamps the interval while leaving the stale reading eligible for refresh.
    focused = false
    vi.setSystemTime(start + 720_000)
    await service.refreshOnOwnerReturn()
    focused = true
    vi.setSystemTime(start + 780_000)
    await service.refreshOnOwnerReturn()
    expect((await service.getState()).kimi?.session?.usedPercent).toBe(60)

    vi.setSystemTime(start + 1_020_000)
    await service.refreshOnOwnerReturn()
    expect((await service.getState()).kimi?.session?.usedPercent).toBe(80)

    usedPercent = 90
    focused = false
    vi.setSystemTime(start + 1_680_000)
    await service.refreshOnOwnerReturn()
    focused = true
    vi.setSystemTime(start + 1_380_000)
    await service.refreshOnOwnerReturn()
    expect((await service.getState()).kimi?.session?.usedPercent).toBe(90)

    usedPercent = 95
    vi.setSystemTime(start + 1_680_000)
    await service.refreshOnOwnerReturn()
    expect((await service.getState()).kimi?.session?.usedPercent).toBe(95)
  } finally {
    service.stop()
  }
})

it('waits out Kimchi Retry-After in automatic full cycles but allows manual refresh', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-11-26T12:00:00Z')
  vi.setSystemTime(now)
  vi.mocked(fetchKimiRateLimits).mockResolvedValue({
    provider: 'kimi',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'unavailable'
  })
  const limited: ProviderRateLimits = {
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: now,
    error: 'Limited',
    status: 'error',
    usageMetadata: { failureKind: 'rate-limited', retryAtMs: now + 600_000 }
  }
  vi.mocked(fetchKimchiRateLimits).mockResolvedValue(limited)
  const service = new RateLimitService()

  try {
    expect((await service.refresh()).kimchi).toEqual(limited)

    await service.refreshIfStale()
    expect(vi.mocked(fetchKimchiRateLimits)).toHaveBeenCalledTimes(1)
    expect((await service.getState()).kimchi).toEqual(limited)

    await service.refresh()
    expect(vi.mocked(fetchKimchiRateLimits)).toHaveBeenCalledTimes(2)
  } finally {
    service.stop()
  }
})

it('preserves sibling usage published during a Kimchi retry credential check', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-11-26T12:00:00Z')
  vi.setSystemTime(now)
  vi.mocked(fetchKimiRateLimits).mockImplementation(unavailable('kimi'))
  const limited: ProviderRateLimits = {
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: now,
    error: 'Limited',
    status: 'error',
    usageMetadata: {
      source: 'cli',
      authProvenance: 'current-account',
      failureKind: 'rate-limited',
      retryAtMs: now + 600_000
    }
  }
  vi.mocked(fetchKimchiRateLimits).mockResolvedValue(limited)
  vi.mocked(readKimchiUsageAuth).mockResolvedValue({
    status: 'ok',
    auth: {
      apiKey: 'current-key',
      apiBaseUrl: 'https://api.cast.ai',
      credentialSource: 'config',
      authProvenance: 'current-account'
    }
  })
  const service = new TestRateLimitService()

  try {
    expect((await service.refresh()).kimchi).toEqual(limited)

    let resolveAuth: ((value: Awaited<ReturnType<typeof readKimchiUsageAuth>>) => void) | undefined
    vi.mocked(readKimchiUsageAuth).mockClear()
    vi.mocked(readKimchiUsageAuth).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve
        })
    )
    vi.mocked(readKimchiUsageAuth).mockResolvedValue({
      status: 'ok',
      auth: {
        apiKey: 'current-key',
        apiBaseUrl: 'https://api.cast.ai',
        credentialSource: 'config',
        authProvenance: 'current-account'
      }
    })
    let resolveKimi: ((value: ProviderRateLimits) => void) | undefined
    vi.mocked(fetchKimiRateLimits).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveKimi = resolve
        })
    )

    const refreshing = service.refreshAutomatically()
    await vi.waitFor(() => expect(readKimchiUsageAuth).toHaveBeenCalledTimes(1))
    service.publishClaude({
      provider: 'claude',
      session: {
        usedPercent: 72,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: null,
      updatedAt: now + 1,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'live-session', authProvenance: 'current-claude-account' }
    })
    resolveAuth?.({
      status: 'ok',
      auth: {
        apiKey: 'current-key',
        apiBaseUrl: 'https://api.cast.ai',
        credentialSource: 'config',
        authProvenance: 'current-account'
      }
    })

    await vi.waitFor(() => expect(resolveKimi).toBeDefined())
    resolveKimi?.(await unavailable('kimi')())
    await refreshing
    expect((await service.getState()).claude?.session?.usedPercent).toBe(72)
  } finally {
    service.stop()
  }
})

it('bypasses Kimchi Retry-After when the signed-in account changes', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-11-26T12:00:00Z')
  vi.setSystemTime(now)
  vi.mocked(fetchKimiRateLimits).mockImplementation(unavailable('kimi'))
  vi.mocked(readKimchiUsageAuth).mockResolvedValue({
    status: 'ok',
    auth: {
      apiKey: 'old-key',
      apiBaseUrl: 'https://api.cast.ai',
      credentialSource: 'config',
      authProvenance: 'old-account'
    }
  })
  const limited: ProviderRateLimits = {
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: now,
    error: 'Limited',
    status: 'error',
    usageMetadata: {
      source: 'cli',
      authProvenance: 'old-account',
      failureKind: 'rate-limited',
      retryAtMs: now + 600_000
    }
  }
  vi.mocked(fetchKimchiRateLimits).mockResolvedValue(limited)
  const service = new TestRateLimitService()

  try {
    expect((await service.refresh()).kimchi).toEqual(limited)
    await service.refreshAutomatically()
    expect(fetchKimchiRateLimits).toHaveBeenCalledTimes(1)

    vi.mocked(readKimchiUsageAuth).mockResolvedValue({
      status: 'ok',
      auth: {
        apiKey: 'new-key',
        apiBaseUrl: 'https://api.cast.ai',
        credentialSource: 'config',
        authProvenance: 'new-account'
      }
    })
    vi.mocked(fetchKimchiRateLimits).mockResolvedValue({
      provider: 'kimchi',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 12,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: null
      },
      updatedAt: now,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'cli', authProvenance: 'new-account' }
    })

    await expect(service.refreshAutomatically()).resolves.toMatchObject({
      kimchi: {
        status: 'ok',
        monthly: { usedPercent: 12 },
        usageMetadata: { authProvenance: 'new-account' }
      }
    })
    expect(fetchKimchiRateLimits).toHaveBeenCalledTimes(2)
  } finally {
    service.stop()
  }
})

it('discards Kimchi usage when credentials change while sibling providers settle', async () => {
  let resolveKimi: ((value: ProviderRateLimits) => void) | undefined
  vi.mocked(fetchKimiRateLimits).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveKimi = resolve
      })
  )
  vi.mocked(fetchKimchiRateLimits).mockResolvedValue({
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: {
      usedPercent: 16,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', authProvenance: 'old-account' }
  })
  vi.mocked(readKimchiUsageAuth).mockResolvedValue({
    status: 'ok',
    auth: {
      apiKey: 'new-key',
      apiBaseUrl: 'https://api.cast.ai',
      credentialSource: 'config',
      authProvenance: 'new-account'
    }
  })
  const service = new RateLimitService()

  try {
    const refreshing = service.refresh()
    await vi.waitFor(() => expect(fetchKimchiRateLimits).toHaveBeenCalledTimes(1))
    expect(readKimchiUsageAuth).not.toHaveBeenCalled()
    resolveKimi?.(await unavailable('kimi')())

    await expect(refreshing).resolves.toMatchObject({
      kimchi: {
        provider: 'kimchi',
        session: null,
        weekly: null,
        monthly: null,
        status: 'error',
        error: 'Kimchi account changed during refresh',
        usageMetadata: {
          authProvenance: 'new-account',
          failureKind: 'missing-credentials'
        }
      }
    })
  } finally {
    service.stop()
  }
})
