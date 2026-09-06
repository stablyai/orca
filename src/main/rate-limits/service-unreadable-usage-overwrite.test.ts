import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { okProvider } from './rate-limit-service-test-harness'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { makeResponse } from './gemini-usage-fetcher.test-fixtures'

const { readFileMock, netFetchMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: vi.fn().mockResolvedValue(null)
}))

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-fetcher', () => ({ fetchOpenCodeGoRateLimits: vi.fn() }))
vi.mock('./minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

const FRESH_AUTH_JSON = {
  google: {
    type: 'oauth',
    access: 'auth-json-access-token',
    expires: new Date('2999-01-01T00:00:00.000Z').getTime(),
    refresh: 'refresh-token-abc|proj-123|managed-456'
  }
}

const READABLE_BUCKET = {
  remainingFraction: 0.4,
  resetTime: '2999-01-01T00:00:00.000Z',
  modelId: 'gemini-2.5-pro'
}

function respondToQuotaWith(body: unknown): void {
  netFetchMock.mockImplementation((url: string) => {
    if (url.includes('retrieveUserQuota')) {
      return Promise.resolve(makeResponse(body))
    }
    if (url.includes('loadCodeAssist')) {
      return Promise.resolve(makeResponse({ cloudaicompanionProject: 'proj-123' }))
    }
    return Promise.resolve(makeResponse({}, 404))
  })
}

// Why: this is the damage the empty-success shape does. The stale policy treats `ok` as fresh and
// returns it verbatim, so an unreadable quota read published as `ok` replaces the account's last
// real usage; published as `error` it keeps the previous snapshot on screen.
describe('RateLimitService with an unreadable Gemini quota read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchKimiRateLimits).mockResolvedValue(okProvider('kimi', 5))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(okProvider('opencode-go', 5))
    vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(okProvider('minimax', 5))
    vi.mocked(fetchGrokRateLimits).mockResolvedValue(okProvider('grok', 5))
    netFetchMock.mockReset()
    readFileMock.mockReset()
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('auth.json')) {
        return JSON.stringify(FRESH_AUTH_JSON)
      }
      throw { code: 'ENOENT' }
    })
  })

  it('keeps the last good Gemini reading when the next quota body cannot be read', async () => {
    const service = new RateLimitService()
    service.setGeminiCliOAuthEnabledResolver(() => true)

    respondToQuotaWith([READABLE_BUCKET])
    await service.refresh()
    expect(service.getState().gemini?.buckets).toHaveLength(1)

    respondToQuotaWith({ error: { code: 500, message: 'internal' } })
    await service.refresh()

    const gemini = service.getState().gemini
    expect(gemini?.status).toBe('error')
    expect(gemini?.buckets).toHaveLength(1)
    expect(gemini?.session?.usedPercent).toBe(60)
  })

  // Why: the mirror is the one place in this class where the blanking is deliberate — see
  // service-antigravity-usage.test.ts, "never leaves a cached Antigravity snapshot in the error
  // retry lane". Pinned here so the asymmetry with Gemini's own retention stays visible: Gemini
  // keeps its last good snapshot through the same failure, Antigravity does not.
  it('drops the mirrored Antigravity reading when the Gemini read fails, unlike Gemini itself', async () => {
    const service = new RateLimitService()
    service.setGeminiCliOAuthEnabledResolver(() => true)

    respondToQuotaWith([READABLE_BUCKET])
    await service.refresh()
    expect(service.getState().antigravity?.buckets).toHaveLength(1)

    respondToQuotaWith({ error: { code: 500, message: 'internal' } })
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('unavailable')
    expect(service.getState().antigravity?.session).toBeNull()
    expect(service.getState().gemini?.session?.usedPercent).toBe(60)
  })
})
