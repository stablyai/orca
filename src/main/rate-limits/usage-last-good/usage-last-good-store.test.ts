import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { RateLimitService } from '../service/rate-limit-service'
import { UsageLastGoodStore } from './usage-last-good-store'

const { now, failing } = vi.hoisted(() => ({
  now: Date.parse('2026-11-25T17:13:00Z'),
  failing: (provider: ProviderRateLimits['provider']) => async (): Promise<ProviderRateLimits> => ({
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Usage is rate limited right now.',
    status: 'error',
    usageMetadata: { failureKind: 'rate-limited' }
  })
}))

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: failing('claude')
}))
vi.mock('../providers/codex/codex-fetcher', () => ({ fetchCodexRateLimits: failing('codex') }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: failing('opencode-go')
}))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: failing('kimi') }))
vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: failing('minimax')
}))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: failing('grok') }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: () => ({ status: 'missing' })
}))
vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: failing('cursor') }))
vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: async () => ({ status: 'missing' })
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: failing('zcode')
}))
vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: failing('antigravity')
}))
vi.mock('../providers/muse/muse-usage-fetcher', () => ({ fetchMuseRateLimits: failing('muse') }))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: async () => false
}))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: async () => false }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: async () => false }))

const HOUR = 3_600_000
const dirs: string[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const window = (usedPercent: number, windowMinutes: number, resetsAt: number) => ({
  usedPercent,
  windowMinutes,
  resetsAt,
  resetDescription: null
})

async function persistThenRestart(
  readings: Partial<Record<'claude' | 'kimi', ProviderRateLimits>>
): Promise<RateLimitService> {
  const dir = mkdtempSync(join(tmpdir(), 'usage-last-good-'))
  dirs.push(dir)
  const file = join(dir, 'last-good.json')
  const before = new UsageLastGoodStore(file)
  await before.loaded
  before.record({
    claude: readings.claude ?? null,
    codex: null,
    opencodeGo: null,
    kimi: readings.kimi ?? null,
    antigravity: null,
    minimax: null,
    grok: null,
    cursor: null,
    zcode: null,
    muse: null
  })
  await before.whenSaved()

  // A new process: nothing in memory but the file.
  const service = new RateLimitService()
  await service.setUsageLastGoodStore(new UsageLastGoodStore(file))
  return service
}

it('keeps the persisted windows when the first poll after a restart fails', async () => {
  const service = await persistThenRestart({
    claude: {
      provider: 'claude',
      session: window(40, 300, now + 2 * HOUR),
      weekly: window(55, 10080, now + 72 * HOUR),
      updatedAt: now - 10 * 60_000,
      error: null,
      status: 'ok'
    }
  })

  const state = await service.refresh()

  expect(state.claude?.status).toBe('error')
  expect(state.claude?.error).toBe('Usage is rate limited right now.')
  expect(state.claude?.session?.usedPercent).toBe(40)
  expect(state.claude?.weekly?.usedPercent).toBe(55)
})

it('does not restore windows whose reset passed while the process was down', async () => {
  const service = await persistThenRestart({
    claude: {
      provider: 'claude',
      session: window(90, 300, now - 60_000),
      weekly: window(55, 10080, now + 72 * HOUR),
      updatedAt: now - 10 * 60_000,
      error: null,
      status: 'ok'
    },
    kimi: {
      provider: 'kimi',
      session: window(70, 300, now - 60_000),
      weekly: null,
      updatedAt: now - 10 * 60_000,
      error: null,
      status: 'ok'
    }
  })

  const seeded = await service.getState()
  expect(seeded.claude?.session).toBeNull()
  expect(seeded.claude?.weekly?.usedPercent).toBe(55)
  expect(seeded.kimi).toBeNull()

  const state = await service.refresh()
  expect(state.claude?.session).toBeNull()
  expect(state.claude?.weekly?.usedPercent).toBe(55)
  expect(state.kimi?.session ?? null).toBeNull()
})
