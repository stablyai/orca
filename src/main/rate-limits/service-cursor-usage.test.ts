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
vi.mock('./cursor-fetcher', () => ({ fetchCursorRateLimits: vi.fn() }))
vi.mock('./cursor-auth', () => ({ readCursorAuthSession: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: vi.fn(() => false) }))

function jwt(): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
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

  it('does not probe the Cursor keychain while callers read state snapshots', () => {
    const service = new RateLimitService()
    service.getState()
    service.getState()
    expect(readCursorAuthSession).not.toHaveBeenCalled()
  })

  it('reports Cursor as unconfigured until a fetch cycle finds a session', async () => {
    const service = new RateLimitService()
    expect(service.getState().cursorAuthConfigured).toBe(false)

    vi.mocked(readCursorAuthSession).mockResolvedValue(signedInResult())
    vi.mocked(fetchCursorRateLimits).mockResolvedValue(okProvider('cursor', 42))
    await service.refresh()

    expect(service.getState().cursorAuthConfigured).toBe(true)
    expect(service.getState().cursor?.status).toBe('ok')
  })

  it('passes the resolved session to the fetcher instead of reading it twice', async () => {
    const authReadResult = signedInResult()
    vi.mocked(readCursorAuthSession).mockResolvedValue(authReadResult)
    vi.mocked(fetchCursorRateLimits).mockResolvedValue(okProvider('cursor', 7))

    await new RateLimitService().refresh()

    expect(readCursorAuthSession).toHaveBeenCalledTimes(1)
    expect(fetchCursorRateLimits).toHaveBeenCalledWith(expect.objectContaining({ authReadResult }))
  })

  it('publishes an error snapshot instead of dropping the cycle when the fetch throws', async () => {
    vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
    vi.mocked(fetchCursorRateLimits).mockRejectedValue(new Error('boom'))

    const service = new RateLimitService()
    await service.refresh()

    const state = service.getState()
    expect(state.cursor).toMatchObject({ provider: 'cursor', status: 'error', error: 'boom' })
    // Why: a Cursor failure must not take the rest of the cycle down with it.
    expect(state.gemini?.status).toBe('ok')
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
