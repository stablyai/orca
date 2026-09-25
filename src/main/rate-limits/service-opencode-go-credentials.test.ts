import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import { ApiKeyFileUnreadableError } from '../credentials/api-key-file-unreadable-error'
import {
  deferred,
  flushMicrotasks,
  okProvider,
  resetRateLimitProviderMocks,
  unavailableProvider
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

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
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

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

const DECRYPT_ERROR =
  'OpenCode Go API key could not be decrypted. Re-enter or clear the key in Settings.'

function serviceWithCookie(apiKeyResolver: () => string | null): RateLimitService {
  const service = new RateLimitService()
  service.setOpenCodeGoConfigResolver(
    () => ({ sessionCookie: 'auth=fake-cookie', workspaceIdOverride: '' }),
    apiKeyResolver
  )
  return service
}

function undecryptableKey(): string | null {
  throw new Error('OpenCode Go API key could not be decrypted')
}

describe('OpenCode Go credential state', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 0))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0))
  })

  it('treats an undecryptable saved key as absent so the cookie still produces usage', async () => {
    const service = serviceWithCookie(undecryptableKey)
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValueOnce(okProvider('opencode-go', 40))

    await service.refresh()

    expect(fetchOpenCodeGoUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settingsApiKey: '', cookie: 'auth=fake-cookie' })
    )
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('ok')
    expect(state.opencodeGo?.error).toBeNull()
  })

  it('shows the decrypt error only when no other source produced usage', async () => {
    const service = serviceWithCookie(undecryptableKey)
    vi.mocked(fetchOpenCodeGoUsage).mockImplementationOnce(async (input) => {
      input.onApiKeyResolved?.({ status: 'missing' })
      return unavailableProvider('opencode-go', 'No OpenCode Go API key or session cookie')
    })

    await service.refresh()

    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.error).toBe(DECRYPT_ERROR)
    // Why: the bar must stay visible to surface how to fix the saved key.
    expect(state.opencodeGoApiKeyConfigured).toBe(true)
  })

  it('skips a transiently unreadable saved key without blaming it, keeping the bar visible', async () => {
    const service = serviceWithCookie(() => {
      throw new ApiKeyFileUnreadableError('OpenCode Go API key file could not be read')
    })
    vi.mocked(fetchOpenCodeGoUsage).mockImplementationOnce(async (input) => {
      input.onApiKeyResolved?.({ status: 'missing' })
      return unavailableProvider('opencode-go', 'No OpenCode Go API key or session cookie')
    })

    await service.refresh()

    expect(fetchOpenCodeGoUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settingsApiKey: '', cookie: 'auth=fake-cookie' })
    )
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('unavailable')
    expect(state.opencodeGo?.error).not.toBe(DECRYPT_ERROR)
    expect(state.opencodeGoApiKeyConfigured).toBe(true)
  })

  it('keeps a real cookie error instead of the decrypt error', async () => {
    const service = serviceWithCookie(undecryptableKey)
    vi.mocked(fetchOpenCodeGoUsage).mockResolvedValueOnce({
      ...unavailableProvider('opencode-go', 'OpenCode session cookie expired'),
      status: 'error'
    })

    await service.refresh()

    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.error).toBe('OpenCode session cookie expired')
  })

  it('keeps the chip visible across a cookie change while a key source exists', async () => {
    const service = serviceWithCookie(() => null)
    vi.mocked(fetchOpenCodeGoUsage).mockImplementation(async (input) => {
      input.onApiKeyResolved?.({ status: 'found', key: 'fake-env-key', tier: 'environment' })
      return okProvider('opencode-go', 10)
    })
    await service.refresh()
    expect(service.getState().opencodeGoApiKeyConfigured).toBe(true)

    service.invalidateOpenCodeGoCredentialState()

    expect(service.getState().opencodeGo?.status).toBe('fetching')
    expect(service.getState().opencodeGoApiKeyConfigured).toBe(true)

    service.invalidateOpenCodeGoCredentialState({ apiKeyCleared: true })
    expect(service.getState().opencodeGoApiKeyConfigured).toBe(false)
  })

  it('passes the saved key to the fetch as the settings override', async () => {
    const service = serviceWithCookie(() => 'fake-saved-key')

    await service.refresh()

    expect(fetchOpenCodeGoUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settingsApiKey: 'fake-saved-key' })
    )
  })

  it('drops an in-flight result fetched with a credential that was since replaced', async () => {
    const service = serviceWithCookie(() => 'fake-old-key')
    const pending = deferred<ProviderRateLimits>()
    let resolvedWithOldKey: (() => void) | undefined
    vi.mocked(fetchOpenCodeGoUsage).mockImplementationOnce((input) => {
      resolvedWithOldKey = () =>
        input.onApiKeyResolved?.({ status: 'found', key: 'fake-old-key', tier: 'settings' })
      return pending.promise
    })

    const refresh = service.refresh()
    await flushMicrotasks()
    service.invalidateOpenCodeGoCredentialState()
    resolvedWithOldKey?.()
    pending.resolve(okProvider('opencode-go', 90))
    await refresh

    const state = service.getState()
    expect(state.opencodeGo?.session?.usedPercent).not.toBe(90)
    expect(state.opencodeGoApiKeyConfigured).toBe(false)
  })
})
