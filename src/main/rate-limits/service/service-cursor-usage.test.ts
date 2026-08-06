import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchCursorRateLimits } from '../providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from '../providers/cursor/cursor-auth'
import { parseCursorSessionToken } from '../providers/cursor/cursor-session-token'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { okProvider, resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

vi.mock('../providers/claude/claude-active-usage-fetch', () => ({
  fetchActiveClaudeRateLimits: vi.fn()
}))
vi.mock('../providers/claude/claude-managed-account-usage', () => ({
  fetchInactiveClaudeAccountUsage: vi.fn()
}))

vi.mock('../providers/codex/codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('../providers/kimi/kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))
vi.mock('../providers/minimax/minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))
vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({ fetchZcodeRateLimits: vi.fn() }))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../deepseek-fetcher', () => ({
  fetchDeepSeekRateLimits: vi.fn(),
  isDeepSeekAuthConfigured: vi.fn(() => false)
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('../providers/cursor/cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

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
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
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
})
