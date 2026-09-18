import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { readCursorAuthSession } from './cursor-auth'
import {
  deferred,
  errorProvider,
  flushMicrotasks,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

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

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn(async () => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

describe('Cursor usage account identity', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
  })

  function signIn(token: string): void {
    vi.mocked(readCursorAuthSession).mockResolvedValue({
      status: 'ok',
      source: 'cli',
      accessToken: token
    })
  }

  it('drops old usage when a different account fails to refresh', async () => {
    const service = new RateLimitService()
    signIn('account-a')
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(okProvider('cursor', 70))
    await service.refresh()
    signIn('account-b')
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(errorProvider('cursor', 'network'))
    await service.refresh()
    expect(service.getState().cursor?.status).toBe('error')
    expect(service.getState().cursor?.session).toBeNull()
  })

  it('discards a late response after signing out during the request', async () => {
    const service = new RateLimitService()
    signIn('account-a')
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchCursorRateLimits).mockReturnValueOnce(pending.promise)
    const refresh = service.refresh()
    await flushMicrotasks()
    vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
    pending.resolve(okProvider('cursor', 70))
    await refresh
    expect(service.getState().cursor?.session ?? null).toBeNull()
    expect(service.getState().cursorAuthConfigured).toBe(false)
  })

  it('keeps stale usage for the same credentials after a transient failure', async () => {
    const service = new RateLimitService()
    signIn('account-a')
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(okProvider('cursor', 70))
    await service.refresh()
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(errorProvider('cursor', 'network'))
    await service.refresh()
    expect(service.getState().cursor?.session?.usedPercent).toBe(70)
    expect(service.getState().cursor?.status).toBe('error')
  })

  it('respects a cooldown even on manual refresh, but does not carry it to another account', async () => {
    const service = new RateLimitService()
    signIn('account-a')
    const limited = errorProvider('cursor', 'rate limited')
    limited.usageMetadata = { failureKind: 'rate-limited', retryAtMs: Date.now() + 120_000 }
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(limited)
    await service.refresh()
    await service.refresh()
    expect(fetchCursorRateLimits).toHaveBeenCalledTimes(1)
    signIn('account-b')
    vi.mocked(fetchCursorRateLimits).mockResolvedValueOnce(okProvider('cursor', 10))
    await service.refresh()
    expect(fetchCursorRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().cursor?.session?.usedPercent).toBe(10)
  })
})
