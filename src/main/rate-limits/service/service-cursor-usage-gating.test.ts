import { beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { fetchCursorRateLimits } from '../providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from '../providers/cursor/cursor-auth'
import { RateLimitService } from './rate-limit-service'

const { unavailable } = vi.hoisted(() => ({
  unavailable:
    (provider: ProviderRateLimits['provider']) => async (): Promise<ProviderRateLimits> => ({
      provider,
      session: null,
      weekly: null,
      updatedAt: Date.parse('2026-11-22T12:00:00Z'),
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
vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: unavailable('gemini')
}))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: unavailable('opencode-go')
}))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: unavailable('kimi') }))
vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: unavailable('minimax')
}))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: unavailable('grok') }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: () => ({ status: 'missing' })
}))
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
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

function cursorReading(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    buckets: [],
    updatedAt: Date.parse('2026-11-22T12:00:00Z'),
    error: null,
    status: 'ok'
  }
}

beforeEach(() => {
  vi.mocked(readCursorAuthSession).mockReset()
  vi.mocked(fetchCursorRateLimits).mockReset()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked fetcher ignores the session payload.
  vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'ok' } as Awaited<
    ReturnType<typeof readCursorAuthSession>
  >)
  vi.mocked(fetchCursorRateLimits).mockResolvedValue(cursorReading(40))
})

it('a hidden Cursor meter reads no credentials and does not resurface its last reading', async () => {
  let enabled = true
  const service = new RateLimitService()
  service.setCursorUsageEnabledResolver(() => enabled)
  try {
    expect((await service.refresh()).cursor?.session?.usedPercent).toBe(40)
    expect(readCursorAuthSession).toHaveBeenCalledTimes(1)

    enabled = false
    const hidden = (await service.refresh()).cursor
    expect(readCursorAuthSession).toHaveBeenCalledTimes(1)
    expect(hidden).toMatchObject({ status: 'idle', error: null, session: null })

    enabled = true
    vi.mocked(fetchCursorRateLimits).mockResolvedValue(cursorReading(55))
    expect((await service.refresh()).cursor?.session?.usedPercent).toBe(55)
    expect(readCursorAuthSession).toHaveBeenCalledTimes(2)
  } finally {
    service.stop()
  }
})
