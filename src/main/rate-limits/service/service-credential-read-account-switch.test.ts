import { beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import {
  deferred,
  flushMicrotasks,
  mockFreshBackgroundProviderFetches,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

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

vi.mock('../providers/gemini/gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('../providers/grok/grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('../providers/cursor/cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('../providers/grok/grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

beforeEach(() => {
  resetRateLimitProviderMocks()
  mockFreshBackgroundProviderFetches()
  vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 90))
})

it('never republishes outgoing Codex usage after a switch during a credential read', async () => {
  const service = new RateLimitService()
  await service.refresh()
  expect((await service.getState()).codex?.session?.usedPercent).toBe(90)
  const entered = Promise.withResolvers<void>()
  const credential = Promise.withResolvers<string | null>()
  service.setOpenCodeGoConfigResolver(
    () => ({ sessionCookie: '', workspaceIdOverride: '' }),
    () => {
      entered.resolve()
      return credential.promise
    }
  )
  const refreshing = service.refresh()
  await entered.promise
  const nextReading = deferred<ProviderRateLimits>()
  vi.mocked(fetchCodexRateLimits).mockReturnValue(nextReading.promise)
  const publications: (number | null)[] = []
  const unsubscribe = service.onStateChange((state) => {
    publications.push(state.codex?.session?.usedPercent ?? null)
  })
  const switching = service.refreshForCodexAccountChange('outgoing')
  credential.resolve(null)
  await flushMicrotasks(40)
  expect((await service.getState()).codex?.session).toBeNull()
  expect(publications).not.toContain(90)
  nextReading.resolve(okProvider('codex', 12))
  await Promise.all([refreshing, switching])
  expect((await service.getState()).codex?.session?.usedPercent).toBe(12)
  expect(publications).not.toContain(90)
  unsubscribe()
})

it('preserves Retry-After when an automatic preparation is retried after a Codex switch', async () => {
  class AutomaticService extends RateLimitService {
    poll() {
      return this.fetchAll()
    }
  }
  const service = new AutomaticService()
  vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue({
    ...okProvider('claude', 15),
    usageMetadata: { retryAtMs: 9_999_999_999_999 }
  })
  await service.refresh()
  vi.mocked(fetchActiveClaudeRateLimits).mockClear()
  const entered = Promise.withResolvers<void>()
  const credential = Promise.withResolvers<string | null>()
  service.setOpenCodeGoConfigResolver(
    () => ({ sessionCookie: '', workspaceIdOverride: '' }),
    () => {
      entered.resolve()
      return credential.promise
    }
  )
  const polling = service.poll()
  await entered.promise
  const switching = service.refreshForCodexAccountChange('outgoing')
  credential.resolve(null)
  await Promise.all([polling, switching])
  expect(fetchActiveClaudeRateLimits).not.toHaveBeenCalled()
  expect((await service.getState()).claude?.session?.usedPercent).toBe(15)
})
