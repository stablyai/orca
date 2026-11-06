import { describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { deferred, flushMicrotasks } from './rate-limit-service-test-harness'

const mocks = vi.hoisted(() => ({
  resolveKey: vi.fn()
}))

vi.mock('./opencode-go-api-key-source', () => ({ resolveOpenCodeGoApiKey: mocks.resolveKey }))
vi.mock('../opencode/opencode-structured-account-home', () => ({
  environmentForStructuredOpenCodeAccountHome: (
    _binding: unknown,
    input: { baseEnvironment: NodeJS.ProcessEnv }
  ) => input.baseEnvironment
}))
vi.mock('../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    list: () => ({ accounts: [{ id: 'account-a' }], activeAccountId: null })
  })
}))
vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('OpenCode text account refresh sharing', () => {
  it('joins one refresh only for callers resolving credentials from the same location', async () => {
    const missing = deferred<{ status: 'missing' }>()
    mocks.resolveKey.mockReturnValue(missing.promise)
    const service = new RateLimitService()
    const refresh = (environment: NodeJS.ProcessEnv, cwd = '/workspace') =>
      service.refreshOpenCodeTextAccounts({
        signal: new AbortController().signal,
        backend: 'v2',
        environment,
        cwd,
        accountIds: ['account-a'],
        freshUntil: 1_700_000_000_000
      })
    const calls = [
      refresh({ XDG_DATA_HOME: '/home-a', PATH: '/bin' }),
      refresh({ XDG_DATA_HOME: '/home-a', PATH: '/usr/bin' }),
      refresh({ XDG_DATA_HOME: '/home-b' }),
      refresh({ XDG_DATA_HOME: '/home-a' }, '/other-workspace')
    ]
    await flushMicrotasks()
    expect(mocks.resolveKey.mock.calls.map(([input]) => input.environment.XDG_DATA_HOME)).toEqual([
      '/home-a',
      '/home-b',
      '/home-a'
    ])
    missing.resolve({ status: 'missing' })
    await Promise.all(calls)
  })
})
