import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZcodeUsageCredentials } from '../providers/zcode/zcode-usage-credentials'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { fetchActiveClaudeRateLimits } from '../providers/claude/claude-active-usage-fetch'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { fetchZcodeRateLimits } from '../providers/zcode/zcode-usage-fetcher'
import {
  deferred,
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

vi.mock('../providers/muse/muse-usage-fetcher', () => ({
  fetchMuseRateLimits: vi.fn()
}))

vi.mock('../providers/antigravity/antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('../providers/kimi/kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('../providers/opencode-go/opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('../providers/zcode/zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn(),
  hasZcodeCliPlanCredentials: vi.fn(() => false)
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

vi.mock('../../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

vi.mock('../../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: vi.fn(() => false),
  readZcodePlanApiKey: vi.fn(() => null),
  saveZcodePlanApiKey: vi.fn(),
  clearZcodePlanApiKey: vi.fn()
}))

describe('RateLimitService zcode plan credentials', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchActiveClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('does not apply an in-flight zcode result after credential invalidation', async () => {
    const service = new RateLimitService()
    const firstZcode = deferred<ProviderRateLimits>()
    const secondZcode = deferred<ProviderRateLimits>()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: 'glm-key' }))
    vi.mocked(fetchZcodeRateLimits)
      .mockImplementationOnce(() => firstZcode.promise)
      .mockImplementationOnce(() => secondZcode.promise)

    const firstRefresh = service.refresh()
    await vi.waitFor(() => expect(service.getState().claude?.status).toBe('ok'))

    service.invalidateZcodeCredentialState()
    const queuedRefresh = service.refresh()
    await Promise.resolve()

    firstZcode.resolve(okProvider('zcode', 50, Date.now()))
    await vi.waitFor(() => expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(2))

    expect(service.getState().zcode?.status).toBe('fetching')
    expect(service.getState().zcode?.session).toBeNull()

    secondZcode.resolve(okProvider('zcode', 10, Date.now()))
    await firstRefresh
    await queuedRefresh

    const state = service.getState()
    expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(2)
    expect(state.zcode?.session?.usedPercent).toBe(10)
  })
  it('rejects an old CLI account result after sibling-provider waits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-zcode-service-v2-'))
    const fixtures = join(import.meta.dirname, '..', '..', 'zcode', 'fixtures', 'v2-upstream')
    vi.stubEnv('ZCODE_DATA_BASE_DIR', home)
    vi.stubEnv('ZCODE_CREDENTIAL_SECRET', 'synthetic-secret')
    try {
      cpSync(join(fixtures, 'zai'), join(home, '.zcode', 'v2'), { recursive: true })
      const selected = readZcodeUsageCredentials()
      if (selected.status !== 'ok') {
        throw new Error('Synthetic fixture could not be read')
      }
      const claude = deferred<ProviderRateLimits>()
      vi.mocked(fetchActiveClaudeRateLimits).mockImplementationOnce(() => claude.promise)
      vi.mocked(fetchZcodeRateLimits).mockResolvedValueOnce({
        ...okProvider('zcode', 44, Date.now()),
        usageMetadata: {
          authProvenance: selected.credentials.authProvenance,
          credentialSource: selected.source
        }
      })
      const service = new RateLimitService()
      const refreshing = service.refresh()
      await vi.waitFor(() => expect(fetchZcodeRateLimits).toHaveBeenCalled())
      cpSync(join(fixtures, 'zai-other'), join(home, '.zcode', 'v2'), { recursive: true })
      claude.resolve(okProvider('claude', 7))
      await refreshing
      expect(service.getState().zcode?.status).toBe('unavailable')
      expect(service.getState().zcode?.session).toBeNull()
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
