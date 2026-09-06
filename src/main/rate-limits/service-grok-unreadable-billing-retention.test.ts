import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import { okProvider } from './rate-limit-service-test-harness'
import { isProviderConfigured } from '../../renderer/src/components/status-bar/status-bar-provider-visibility'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-fetcher', () => ({ fetchOpenCodeGoRateLimits: vi.fn() }))
vi.mock('./minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))
// Why: only the Grok fetcher is real here — the point is what the live billing read publishes.
vi.mock('./grok-auth', () => ({
  isGrokAccessTokenFresh: () => true,
  readGrokAuthSession: () => ({
    status: 'ok',
    session: {
      accessToken: 'access-token',
      userId: 'user-1',
      email: 'dev@example.com',
      teamId: null,
      expiresAtMs: null,
      oidcClientId: null
    }
  })
}))

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function respondToBillingWith(body: unknown): void {
  netFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body)))
}

// Why: `unavailable` is destructive twice over — `applyStalePolicy` returns it verbatim, dropping
// the previous snapshot, and `isProviderConfigured` then hides the chip that would have told the
// user anything was wrong. Both halves are asserted here against the real fetcher.
describe('RateLimitService with an unreadable Grok billing read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 5))
    vi.mocked(fetchKimiRateLimits).mockResolvedValue(okProvider('kimi', 5))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(okProvider('opencode-go', 5))
    vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(okProvider('minimax', 5))
    netFetchMock.mockReset()
  })

  it('keeps the last good Grok reading and the chip when the next billing body cannot be read', async () => {
    const service = new RateLimitService()

    respondToBillingWith({ config: { creditUsagePercent: 41 } })
    await service.refresh()
    expect(service.getState().grok?.weekly?.usedPercent).toBe(41)

    respondToBillingWith({ config: 'invalid' })
    await service.refresh()

    const grok = service.getState().grok
    expect(grok?.status).toBe('error')
    expect(grok?.weekly?.usedPercent).toBe(41)
    expect(isProviderConfigured(grok)).toBe(true)
  })

  // Why: the retention above must not come from making every windowless answer non-destructive —
  // a signed-in account that genuinely has no weekly credits still reads as unconfigured.
  it('still discards the snapshot and hides the chip when the plan genuinely has no credits', async () => {
    const service = new RateLimitService()

    respondToBillingWith({ config: { creditUsagePercent: 41 } })
    await service.refresh()
    expect(service.getState().grok?.weekly?.usedPercent).toBe(41)

    // A billing view Orca recognises, carrying no credit field — not `{}`, which names no billing
    // field at all and is therefore a failed read rather than a plan without credits.
    respondToBillingWith({ subscriptionTier: 'Enterprise' })
    await service.refresh()

    const grok = service.getState().grok
    expect(grok?.status).toBe('unavailable')
    expect(grok?.weekly).toBeNull()
    expect(isProviderConfigured(grok)).toBe(false)
  })
})
