import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
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
  fetchActiveClaudeRateLimits: unavailable('claude')
}))
vi.mock('../providers/codex/codex-fetcher', () => ({
  fetchCodexRateLimits: unavailable('codex')
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
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: unavailable('antigravity')
}))
vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: unavailable('muse')
}))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: async () => false }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: async () => false }))

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
