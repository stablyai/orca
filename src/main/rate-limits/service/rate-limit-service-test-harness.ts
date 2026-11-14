import { EventEmitter } from 'node:events'
import { vi, type Mock } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { RateLimitService } from './rate-limit-service'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchGeminiRateLimits } from '../providers/gemini/gemini-usage-fetcher'
import { fetchKimiRateLimits } from '../providers/kimi/kimi-fetcher'
import { fetchMiniMaxRateLimits } from '../providers/minimax/minimax-fetcher'
import { fetchGrokRateLimits } from '../providers/grok/grok-fetcher'
import { readGrokAuthSession } from '../providers/grok/grok-auth'
import { fetchCursorRateLimits } from '../providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from '../providers/cursor/cursor-auth'
import { fetchOpenCodeGoUsage } from '../providers/opencode-go/opencode-go-usage-source-selection'
import { fetchZcodeRateLimits } from '../providers/zcode/zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from '../providers/antigravity/antigravity-usage-fetcher'
import { fetchMuseRateLimits } from '../providers/muse/muse-usage-fetcher'
import { hasMiniMaxSessionCookie } from '../../minimax/minimax-cookie-store'

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export function okProvider(
  provider: ProviderRateLimits['provider'],
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

export function errorProvider(
  provider: ProviderRateLimits['provider'],
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

export function unavailableProvider(
  provider: ProviderRateLimits['provider'],
  message = 'Not configured'
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'unavailable'
  }
}

// Mint timestamps at fetch time: suite-start snapshots become stale under fake timers and turn retry tests into full fetches.
export function mockFreshBackgroundProviderFetches(): void {
  vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 24))
  vi.mocked(fetchGeminiRateLimits).mockImplementation(async () => okProvider('gemini', 0))
  vi.mocked(fetchOpenCodeGoUsage).mockImplementation(async () => okProvider('opencode-go', 0))
  vi.mocked(fetchKimiRateLimits).mockImplementation(async () => okProvider('kimi', 0))
  vi.mocked(fetchMiniMaxRateLimits).mockImplementation(async () => okProvider('minimax', 0))
  vi.mocked(fetchGrokRateLimits).mockImplementation(async () => unavailableProvider('grok'))
  vi.mocked(fetchCursorRateLimits).mockImplementation(async () => unavailableProvider('cursor'))
  vi.mocked(fetchZcodeRateLimits).mockImplementation(async () => unavailableProvider('zcode'))
  vi.mocked(fetchAntigravityRateLimits).mockImplementation(async () =>
    unavailableProvider('antigravity')
  )
  vi.mocked(fetchMuseRateLimits).mockImplementation(async () => unavailableProvider('muse'))
}

export function resetRateLimitProviderMocks(): void {
  vi.clearAllMocks()
  vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 0, Date.now()))
  vi.mocked(fetchKimiRateLimits).mockResolvedValue(okProvider('kimi', 0, Date.now()))
  vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(okProvider('minimax', 0, Date.now()))
  vi.mocked(fetchGrokRateLimits).mockResolvedValue({
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'unavailable'
  })
  vi.mocked(fetchCursorRateLimits).mockResolvedValue(unavailableProvider('cursor'))
  vi.mocked(fetchZcodeRateLimits).mockResolvedValue(unavailableProvider('zcode'))
  vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(unavailableProvider('antigravity'))
  vi.mocked(fetchMuseRateLimits).mockResolvedValue(unavailableProvider('muse'))
  vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(false)
  vi.mocked(readGrokAuthSession).mockReturnValue({ status: 'missing' })
  vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
}

type RateLimitWindow = Parameters<RateLimitService['attach']>[0]

export type FakeWindowWebContents = {
  send: Mock<(channel: string, ...args: unknown[]) => void>
}

export class FakeRateLimitWindow extends EventEmitter {
  focused = true
  minimized = false
  visible = true

  webContents: FakeWindowWebContents = {
    send: vi.fn()
  }

  isDestroyed(): boolean {
    return false
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isFocused(): boolean {
    return this.focused
  }
}

export function asRateLimitWindow(window: FakeRateLimitWindow): RateLimitWindow {
  return window as unknown as RateLimitWindow
}

export async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}
