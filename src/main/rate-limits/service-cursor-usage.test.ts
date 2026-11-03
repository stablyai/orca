import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { readCursorAuthSession } from './cursor-auth'
import { parseCursorSessionToken } from './cursor-session-token'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { okProvider, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

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
vi.mock('./opencode-go-usage-source-selection', () => ({ fetchOpenCodeGoUsage: vi.fn() }))
vi.mock('./minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn(() => ({ status: 'missing' })) }))
vi.mock('./zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))

type JwtSegment = Record<string, unknown>

function jwt(): string {
  const encode = (value: JwtSegment): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub: 'auth0|user_1', exp: 4_000_000_000 })}.sig`
}

function signedInResult(): Awaited<ReturnType<typeof readCursorAuthSession>> {
  return {
    status: 'ok',
    session: {
      token: parseCursorSessionToken(jwt())!,
      source: 'keychain',
      email: 'dev@example.com',
      displayName: 'Dev',
      membershipType: 'pro',
      subscriptionStatus: 'active'
    }
  }
}

describe('RateLimitService Cursor usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
  })

  it('publishes an error snapshot instead of dropping the cycle when the fetch throws', async () => {
    vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
    vi.mocked(fetchCursorRateLimits).mockRejectedValue(new Error('boom'))

    const service = new RateLimitService()
    await service.refresh()

    const state = service.getState()
    expect(state.cursor).toMatchObject({ provider: 'cursor', status: 'error', error: 'boom' })
    expect(state.gemini?.status).toBe('ok')
  })

  it("drops a previous account's usage when the signed-in account changes", async () => {
    // Stale-policy fallback must never put the previous account's figures beside a newly selected identity.
    vi.mocked(readCursorAuthSession).mockResolvedValue(signedInResult())
    vi.mocked(fetchCursorRateLimits).mockResolvedValue({
      ...okProvider('cursor', 80),
      usageMetadata: { source: 'cli', authProvenance: 'account-a' }
    })
    const service = new RateLimitService()
    await service.refresh()
    expect(service.getState().cursor?.session?.usedPercent).toBe(80)

    vi.mocked(fetchCursorRateLimits).mockResolvedValue({
      provider: 'cursor',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Cursor sign-in expired — run `cursor-agent login` again',
      status: 'error',
      // Match a readable session rejected after an account switch.
      usageMetadata: { source: 'cli', failureKind: 'stale-token', authProvenance: 'account-b' }
    })
    await service.refresh()
    expect(service.getState().cursor?.session).toBeNull()
    expect(service.getState().cursor?.status).toBe('error')
  })

  it('keeps the last reading when a refresh fails without naming an account', async () => {
    vi.mocked(readCursorAuthSession).mockResolvedValue(signedInResult())
    vi.mocked(fetchCursorRateLimits).mockResolvedValue({
      ...okProvider('cursor', 60),
      usageMetadata: { source: 'cli', authProvenance: 'account-a' }
    })
    const service = new RateLimitService()
    await service.refresh()

    vi.mocked(fetchCursorRateLimits).mockResolvedValue({
      provider: 'cursor',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Cursor usage request failed',
      status: 'error',
      usageMetadata: { source: 'cli' }
    })
    await service.refresh()
    expect(service.getState().cursor?.session?.usedPercent).toBe(60)
  })

  it('clears cursorAuthConfigured once the local session goes away', async () => {
    vi.mocked(readCursorAuthSession).mockResolvedValue(signedInResult())
    vi.mocked(fetchCursorRateLimits).mockResolvedValue(okProvider('cursor', 5))
    const service = new RateLimitService()
    await service.refresh()
    expect(service.getState().cursorAuthConfigured).toBe(true)

    vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
    await service.refresh()
    expect(service.getState().cursorAuthConfigured).toBe(false)
  })
})
