import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchKimiRateLimits } from '../providers/kimi/kimi-fetcher'
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
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/codex/codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: unavailable('opencode-go')
}))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
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

const start = Date.parse('2026-11-22T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  vi.mocked(fetchActiveClaudeRateLimits).mockReset().mockImplementation(unavailable('claude'))
  vi.mocked(fetchCodexRateLimits).mockReset().mockImplementation(unavailable('codex'))
  vi.mocked(fetchKimiRateLimits).mockReset().mockImplementation(unavailable('kimi'))
})

afterEach(() => {
  vi.useRealTimers()
})

function reading(
  provider: ProviderRateLimits['provider'],
  usedPercent: number
): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

it('publishes local usage without a window activation and limits repeated owner returns', async () => {
  let usedPercent = 10
  vi.mocked(fetchKimiRateLimits).mockImplementation(async () => reading('kimi', usedPercent))
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

it('preserves a Codex reading when its home becomes gated during a full read', async () => {
  const service = new RateLimitService()
  const codex = vi.mocked(fetchCodexRateLimits)
  const kimi = vi.mocked(fetchKimiRateLimits)
  let gated = false
  service.setCodexHomePathResolver(() =>
    gated ? { kind: 'skip' } : { kind: 'ready', codexHomePath: null }
  )

  try {
    codex.mockImplementation(async () => reading('codex', 36))
    kimi.mockImplementation(async () => reading('kimi', 10))
    expect((await service.refresh()).codex?.session?.usedPercent).toBe(36)

    vi.setSystemTime(start + 290_000)
    codex.mockImplementationOnce(async () => {
      gated = true
      return reading('codex', 67)
    })
    expect((await service.refresh()).codex?.session?.usedPercent).toBe(36)

    vi.setSystemTime(start + 305_000)
    kimi.mockImplementation(async () => reading('kimi', 60))
    expect((await service.refreshIfStale()).kimi?.session?.usedPercent).toBe(10)

    vi.setSystemTime(start + 590_000)
    gated = false
    codex.mockImplementation(async () => reading('codex', 72))
    expect((await service.refreshIfStale()).codex?.session?.usedPercent).toBe(72)
  } finally {
    service.stop()
  }
})

function claudeFailure(error: string, retryAtMs?: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    ...(retryAtMs === undefined
      ? {}
      : { usageMetadata: { failureKind: 'rate-limited', retryAtMs } })
  }
}

it('starts Claude backoff when a hold expires during full refresh preparation', async () => {
  const service = new RateLimitService()
  const claude = vi.mocked(fetchActiveClaudeRateLimits)
  const ready = { kind: 'ready' as const, codexHomePath: null }
  const homePrepared = Promise.withResolvers<typeof ready>()
  const preparingHome = Promise.withResolvers<void>()
  const resolveCodexHome = vi.fn(async () => ready)
  service.setCodexHomePathResolver(resolveCodexHome)

  try {
    claude.mockImplementation(async () => claudeFailure('Initial failure'))
    expect((await service.refresh()).claude?.error).toBe('Initial failure')

    const holdUntil = start + 310_000
    vi.setSystemTime(start + 1_000)
    claude.mockImplementation(async () => claudeFailure('Rate limited', holdUntil))
    expect((await service.refreshIfStale()).claude?.usageMetadata?.retryAtMs).toBe(holdUntil)

    vi.setSystemTime(start + 300_000)
    resolveCodexHome.mockImplementationOnce(() => {
      preparingHome.resolve()
      return homePrepared.promise
    })
    const activation = service.refreshIfStale()
    await preparingHome.promise
    vi.setSystemTime(holdUntil)
    claude.mockImplementation(async () => claudeFailure('Full read failed'))
    homePrepared.resolve(ready)
    expect((await activation).claude?.error).toBe('Full read failed')

    claude.mockImplementation(async () => reading('claude', 72))
    vi.setSystemTime(start + 311_000)
    expect((await service.refreshIfStale()).claude?.error).toBe('Full read failed')

    vi.setSystemTime(start + 429_000)
    expect((await service.refreshIfStale()).claude?.error).toBe('Full read failed')

    vi.setSystemTime(start + 430_000)
    expect((await service.refreshIfStale()).claude?.session?.usedPercent).toBe(72)
  } finally {
    homePrepared.resolve(ready)
    service.stop()
  }
})
