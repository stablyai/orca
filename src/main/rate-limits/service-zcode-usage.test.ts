import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { hasZcodePlanApiKey } from '../zcode/zcode-plan-api-key-store'
import {
  deferred,
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

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./kiro-usage-fetcher', () => ({
  fetchKiroRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn(),
  hasZcodeCliPlanCredentials: vi.fn(() => false)
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

vi.mock('../minimax/minimax-api-key-store', () => ({
  hasMiniMaxApiKey: vi.fn(() => false)
}))

vi.mock('../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: vi.fn(() => false),
  readZcodePlanApiKey: vi.fn(() => null),
  saveZcodePlanApiKey: vi.fn(),
  clearZcodePlanApiKey: vi.fn()
}))

describe('RateLimitService zcode plan credentials', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches zcode with the site-resolved plan credential when a resolver is set', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'bigmodel', apiKey: 'glm-key' }))
    vi.mocked(hasZcodePlanApiKey).mockReturnValue(true)
    vi.mocked(fetchZcodeRateLimits).mockResolvedValueOnce(okProvider('zcode', 33, Date.now()))

    await service.refresh()

    expect(fetchZcodeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchZcodeRateLimits).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn' }
    })
    const state = service.getState()
    expect(state.zcode?.status).toBe('ok')
    expect(state.zcode?.session?.usedPercent).toBe(33)
    expect(state.zcodePlanApiKeyConfigured).toBe(true)
  })

  it('passes no plan credential while no key is saved and still fetches via the CLI config', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => ({ site: 'zai', apiKey: '' }))
    vi.mocked(fetchZcodeRateLimits).mockResolvedValueOnce(okProvider('zcode', 12, Date.now()))

    await service.refresh()

    expect(fetchZcodeRateLimits).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: null
    })
    expect(service.getState().zcode?.session?.usedPercent).toBe(12)
  })

  it('surfaces a resolver failure as a zcode-only error without fetching', async () => {
    const service = new RateLimitService()
    service.setZcodePlanConfigResolver(() => {
      throw new Error('GLM Coding Plan API key could not be decrypted')
    })

    await service.refresh()

    expect(fetchZcodeRateLimits).not.toHaveBeenCalled()
    const zcode = service.getState().zcode
    expect(zcode?.status).toBe('error')
    expect(zcode?.error).toContain('could not be decrypted')
    expect(zcode?.usageMetadata?.failureKind).toBe('keychain-unavailable')
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('discards the previous zcode snapshot when the saved site changes', async () => {
    const service = new RateLimitService()
    let site: 'zai' | 'bigmodel' = 'zai'
    service.setZcodePlanConfigResolver(() => ({ site, apiKey: 'glm-key' }))
    vi.mocked(fetchZcodeRateLimits)
      .mockResolvedValueOnce(okProvider('zcode', 40, Date.now()))
      .mockRejectedValueOnce(new Error('Zcode quota request failed (401)'))

    await service.refresh()
    expect(service.getState().zcode?.session?.usedPercent).toBe(40)

    site = 'bigmodel'
    await service.refresh()

    const state = service.getState()
    expect(fetchZcodeRateLimits).toHaveBeenLastCalledWith({
      signal: expect.any(AbortSignal),
      planCredential: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn' }
    })
    expect(state.zcode?.status).toBe('error')
    expect(state.zcode?.session).toBeNull()
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
})
