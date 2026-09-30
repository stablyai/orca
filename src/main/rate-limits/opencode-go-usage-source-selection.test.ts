import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { OpenCodeGoUsageWindows } from './opencode-go-status-parsing'
import type * as usageFetcher from './opencode-go-usage-fetcher'

const resolveApiKeyMock = vi.hoisted(() => vi.fn())
const fetchWithApiKeyMock = vi.hoisted(() => vi.fn())
const fetchWithCookieMock = vi.hoisted(() => vi.fn())

vi.mock('./opencode-go-api-key-source', () => ({ resolveOpenCodeGoApiKey: resolveApiKeyMock }))
vi.mock('./opencode-go-usage-api', () => ({
  fetchOpenCodeGoUsageWithApiKey: fetchWithApiKeyMock
}))
vi.mock('./opencode-go-usage-fetcher', async (importOriginal) => {
  const actual: typeof usageFetcher = await importOriginal()
  return {
    normalizeCookieInput: actual.normalizeCookieInput,
    fetchOpenCodeGoRateLimits: fetchWithCookieMock
  }
})

import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'

// Placeholder only — a real key must never reach a fixture.
const API_KEY = 'placeholder-go-key'
const COOKIE = 'auth=placeholder; __Host-console_session=placeholder'

const WINDOWS: OpenCodeGoUsageWindows = {
  session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: { usedPercent: 34, windowMinutes: 10080, resetsAt: null, resetDescription: null },
  monthly: null
}

function cookieResult(status: ProviderRateLimits['status']): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: status === 'ok' ? WINDOWS.session : null,
    weekly: status === 'ok' ? WINDOWS.weekly : null,
    monthly: null,
    updatedAt: Date.now(),
    error: status === 'ok' ? null : 'Usage fetch failed (401)',
    status
  }
}

describe('fetchOpenCodeGoUsage', () => {
  beforeEach(() => {
    resolveApiKeyMock.mockReset()
    fetchWithApiKeyMock.mockReset()
    fetchWithCookieMock.mockReset()
  })

  it('uses the API key ahead of a configured cookie and records its tier', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'found', key: API_KEY, tier: 'environment' })
    fetchWithApiKeyMock.mockResolvedValue({ kind: 'ok', windows: WINDOWS })
    const onApiKeyResolved = vi.fn()

    const result = await fetchOpenCodeGoUsage({ cookie: COOKIE, onApiKeyResolved })

    expect(fetchWithCookieMock).not.toHaveBeenCalled()
    expect(onApiKeyResolved).toHaveBeenCalledWith({
      status: 'found',
      key: API_KEY,
      tier: 'environment'
    })
    expect(result.status).toBe('ok')
    expect(result.session).toEqual(WINDOWS.session)
    expect(result.usageMetadata?.credentialSource).toBe('environment')
  })

  it('passes the settings override down as the highest-precedence tier', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'missing' })

    await fetchOpenCodeGoUsage({ cookie: '', settingsApiKey: API_KEY })

    expect(resolveApiKeyMock).toHaveBeenCalledWith({ settingsOverride: API_KEY })
  })

  it('names the missing subscription instead of a generic refresh failure', async () => {
    resolveApiKeyMock.mockResolvedValue({
      status: 'found',
      key: API_KEY,
      tier: 'opencode-auth-file'
    })
    fetchWithApiKeyMock.mockResolvedValue({ kind: 'no-subscription' })

    const result = await fetchOpenCodeGoUsage({ cookie: '' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('no-subscription')
    expect(result.error).toContain('no OpenCode Go subscription')
    expect(result.error).not.toContain(API_KEY)
  })

  it('keeps a working cookie account alive when the key has no Go entitlement', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'found', key: API_KEY, tier: 'settings' })
    fetchWithApiKeyMock.mockResolvedValue({ kind: 'no-subscription' })
    fetchWithCookieMock.mockResolvedValue(cookieResult('ok'))

    const result = await fetchOpenCodeGoUsage({ cookie: COOKIE })

    expect(fetchWithCookieMock).toHaveBeenCalledWith(COOKIE, undefined, undefined)
    expect(result.status).toBe('ok')
  })

  it('reports the key verdict when the cookie fallback also fails', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'found', key: API_KEY, tier: 'settings' })
    fetchWithApiKeyMock.mockResolvedValue({ kind: 'unauthorized' })
    fetchWithCookieMock.mockResolvedValue(cookieResult('error'))

    const result = await fetchOpenCodeGoUsage({ cookie: COOKIE })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.error).toContain('/connect')
  })

  it('surfaces a transport failure without exposing the key', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'found', key: API_KEY, tier: 'settings' })
    fetchWithApiKeyMock.mockResolvedValue({
      kind: 'failed',
      message: 'OpenCode Go usage request failed (503)'
    })

    const result = await fetchOpenCodeGoUsage({ cookie: '' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toBe('OpenCode Go usage request failed (503)')
  })

  it('falls back to the cookie path when no key exists anywhere', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'missing' })
    fetchWithCookieMock.mockResolvedValue(cookieResult('ok'))

    const proxy = { httpProxyUrl: 'http://proxy.example:8080', httpProxyBypassRules: '' }
    const result = await fetchOpenCodeGoUsage({
      cookie: COOKIE,
      workspaceIdOverride: 'wrk_abc',
      networkProxySettings: proxy
    })

    expect(fetchWithApiKeyMock).not.toHaveBeenCalled()
    expect(fetchWithCookieMock).toHaveBeenCalledWith(COOKIE, 'wrk_abc', proxy)
    expect(result.status).toBe('ok')
  })

  it('stays unavailable when neither a key nor a cookie is configured', async () => {
    resolveApiKeyMock.mockResolvedValue({ status: 'missing' })

    const result = await fetchOpenCodeGoUsage({ cookie: '   ' })

    expect(fetchWithCookieMock).not.toHaveBeenCalled()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
  })
})
