import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchZhipuRateLimits } from './zhipu-fetcher'
import { hasZhipuCredentials, readZhipuCredentials } from '../zhipu/zhipu-credential-store'
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

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./zhipu-fetcher', () => ({
  fetchZhipuRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

vi.mock('../zhipu/zhipu-credential-store', () => ({
  hasZhipuCredentials: vi.fn(() => false),
  readZhipuCredentials: vi.fn(() => null)
}))

describe('RateLimitService Zhipu usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches Zhipu usage from stored credentials', async () => {
    const service = new RateLimitService()
    vi.mocked(hasZhipuCredentials).mockReturnValue(true)
    vi.mocked(readZhipuCredentials).mockReturnValue({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authToken: 'zai-token'
    })
    vi.mocked(fetchZhipuRateLimits).mockResolvedValueOnce(okProvider('zhipu', 62, Date.now()))

    await service.refresh()

    expect(fetchZhipuRateLimits).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        authToken: 'zai-token'
      })
    )
    expect(service.getState().zhipu).toMatchObject({
      provider: 'zhipu',
      status: 'ok',
      session: expect.objectContaining({ usedPercent: 62 })
    })
    expect(service.getState().zhipuCredentialsConfigured).toBe(true)
  })

  it('does not reread Zhipu credentials when callers read state snapshots', () => {
    vi.mocked(hasZhipuCredentials).mockReturnValue(true)
    const service = new RateLimitService()
    vi.mocked(hasZhipuCredentials).mockClear()

    expect(service.getState().zhipuCredentialsConfigured).toBe(true)
    service.getState()

    expect(hasZhipuCredentials).not.toHaveBeenCalled()
    expect(readZhipuCredentials).not.toHaveBeenCalled()
  })

  it('isolates Zhipu credential read failures from other providers', async () => {
    vi.mocked(hasZhipuCredentials).mockReturnValue(true)
    vi.mocked(readZhipuCredentials).mockImplementation(() => {
      throw new Error('Zhipu credentials could not be decrypted')
    })
    const service = new RateLimitService()

    await service.refresh()

    expect(fetchZhipuRateLimits).not.toHaveBeenCalled()
    expect(service.getState().zhipu).toMatchObject({
      provider: 'zhipu',
      status: 'error',
      error: 'Zhipu credentials could not be decrypted',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    })
    expect(service.getState().zhipuCredentialsConfigured).toBe(true)
    expect(service.getState().claude?.status).toBe('ok')
  })

  it('does not apply an in-flight Zhipu result after credential invalidation', async () => {
    vi.mocked(hasZhipuCredentials).mockReturnValue(true)
    vi.mocked(readZhipuCredentials).mockReturnValue({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      authToken: 'zai-token'
    })
    const service = new RateLimitService()
    const firstZhipu = deferred<ProviderRateLimits>()
    const secondZhipu = deferred<ProviderRateLimits>()
    vi.mocked(fetchZhipuRateLimits)
      .mockImplementationOnce(() => firstZhipu.promise)
      .mockImplementationOnce(() => secondZhipu.promise)

    const firstRefresh = service.refresh()
    await Promise.resolve()

    service.invalidateZhipuCredentialState()
    const queuedRefresh = service.refresh()
    await Promise.resolve()

    firstZhipu.resolve(okProvider('zhipu', 50, Date.now()))
    await Promise.resolve()
    await Promise.resolve()

    expect(service.getState().zhipu?.status).toBe('fetching')
    expect(service.getState().zhipu?.session).toBeNull()

    secondZhipu.resolve(okProvider('zhipu', 10, Date.now()))
    await firstRefresh
    await queuedRefresh

    expect(fetchZhipuRateLimits).toHaveBeenCalledTimes(2)
    expect(service.getState().zhipu?.session?.usedPercent).toBe(10)
  })
})
