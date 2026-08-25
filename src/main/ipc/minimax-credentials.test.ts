import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

const saveMiniMaxSessionCookieMock = vi.hoisted(() => vi.fn())
const clearMiniMaxSessionCookieMock = vi.hoisted(() => vi.fn())
const hasMiniMaxSessionCookieMock = vi.hoisted(() => vi.fn(() => false))
const clearMiniMaxSessionCookieJarMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const saveMiniMaxApiKeyMock = vi.hoisted(() => vi.fn())
const clearMiniMaxApiKeyMock = vi.hoisted(() => vi.fn())
const hasMiniMaxApiKeyMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('../minimax/minimax-cookie-store', () => ({
  saveMiniMaxSessionCookie: saveMiniMaxSessionCookieMock,
  clearMiniMaxSessionCookie: clearMiniMaxSessionCookieMock,
  hasMiniMaxSessionCookie: hasMiniMaxSessionCookieMock
}))

vi.mock('../minimax/minimax-api-key-store', () => ({
  saveMiniMaxApiKey: saveMiniMaxApiKeyMock,
  clearMiniMaxApiKey: clearMiniMaxApiKeyMock,
  hasMiniMaxApiKey: hasMiniMaxApiKeyMock
}))

vi.mock('../rate-limits/minimax-request-context', () => ({
  clearMiniMaxSessionCookieJar: clearMiniMaxSessionCookieJarMock
}))

import { registerMiniMaxCredentialsHandlers } from './minimax-credentials'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitState } from '../../shared/rate-limit-types'

function makeRefreshMock(): {
  refresh: ReturnType<typeof vi.fn>
  invalidateMiniMaxCredentialState: ReturnType<typeof vi.fn>
  service: Pick<RateLimitService, 'refresh' | 'invalidateMiniMaxCredentialState'>
} {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const invalidateMiniMaxCredentialState = vi.fn()
  return {
    refresh,
    invalidateMiniMaxCredentialState,
    service: { refresh, invalidateMiniMaxCredentialState }
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return (await handler({}, ...args)) as T
}

describe('registerMiniMaxCredentialsHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
    saveMiniMaxSessionCookieMock.mockReset()
    clearMiniMaxSessionCookieMock.mockReset()
    clearMiniMaxSessionCookieJarMock.mockReset()
    clearMiniMaxSessionCookieJarMock.mockResolvedValue(undefined)
    hasMiniMaxSessionCookieMock.mockReset()
    hasMiniMaxSessionCookieMock.mockReturnValue(false)
    saveMiniMaxApiKeyMock.mockReset()
    clearMiniMaxApiKeyMock.mockReset()
    hasMiniMaxApiKeyMock.mockReset()
    hasMiniMaxApiKeyMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers all five MiniMax credential channels', () => {
    registerMiniMaxCredentialsHandlers(null)
    expect(ipcState.handleHandlers.has('minimaxCredentials:getStatus')).toBe(true)
    expect(ipcState.handleHandlers.has('minimaxCredentials:saveCookie')).toBe(true)
    expect(ipcState.handleHandlers.has('minimaxCredentials:clearCookie')).toBe(true)
    expect(ipcState.handleHandlers.has('minimaxCredentials:saveApiKey')).toBe(true)
    expect(ipcState.handleHandlers.has('minimaxCredentials:clearApiKey')).toBe(true)
  })

  it('returns the configured state on getStatus from the cookie store', async () => {
    hasMiniMaxSessionCookieMock.mockReturnValue(true)
    registerMiniMaxCredentialsHandlers(null)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:getStatus')
    expect(status).toEqual({
      configured: true,
      cookieConfigured: true,
      apiKeyConfigured: false
    })
  })

  it('returns apiKeyConfigured true on getStatus when the API key store has a key', async () => {
    hasMiniMaxApiKeyMock.mockReturnValue(true)
    registerMiniMaxCredentialsHandlers(null)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:getStatus')
    expect(status).toEqual({
      configured: true,
      cookieConfigured: false,
      apiKeyConfigured: true
    })
  })

  it('persists the cookie and reports configured after saveCookie', async () => {
    hasMiniMaxSessionCookieMock.mockReturnValueOnce(true)
    registerMiniMaxCredentialsHandlers(null)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:saveCookie', '_token=abc; minimax_group_id_v2=42')
    expect(saveMiniMaxSessionCookieMock).toHaveBeenCalledWith('_token=abc; minimax_group_id_v2=42')
    expect(status).toMatchObject({ configured: true, cookieConfigured: true })
  })

  it('triggers a rate-limit refresh after saveCookie when a service is provided', async () => {
    const { refresh, invalidateMiniMaxCredentialState, service } = makeRefreshMock()
    registerMiniMaxCredentialsHandlers(service as RateLimitService)
    await invoke('minimaxCredentials:saveCookie', '_token=abc')
    // Why: the save handler is fire-and-forget — wait a microtask cycle so
    // the queued `void rateLimits?.refresh()` resolves before we assert.
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not throw when saveCookie runs without a rate-limit service', async () => {
    registerMiniMaxCredentialsHandlers(null)
    await expect(invoke('minimaxCredentials:saveCookie', '_token=abc')).resolves.toBeDefined()
  })

  it('clears the cookie and triggers a refresh on clearCookie', async () => {
    const { refresh, invalidateMiniMaxCredentialState, service } = makeRefreshMock()
    hasMiniMaxSessionCookieMock.mockReturnValueOnce(false)
    registerMiniMaxCredentialsHandlers(service as RateLimitService)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:clearCookie')
    expect(clearMiniMaxSessionCookieMock).toHaveBeenCalledTimes(1)
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(clearMiniMaxSessionCookieJarMock).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({ configured: false, cookieConfigured: false })
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still refreshes and reports cleared when session jar cleanup rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { refresh, invalidateMiniMaxCredentialState, service } = makeRefreshMock()
    clearMiniMaxSessionCookieJarMock.mockRejectedValueOnce(new Error('jar boom'))
    hasMiniMaxSessionCookieMock.mockReturnValueOnce(false)
    registerMiniMaxCredentialsHandlers(service as RateLimitService)

    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:clearCookie')

    expect(clearMiniMaxSessionCookieMock).toHaveBeenCalledTimes(1)
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(clearMiniMaxSessionCookieJarMock).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({ configured: false, cookieConfigured: false })
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to clear session cookie jar after credential clear'),
      expect.any(Error)
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('logs but does not throw when the post-save rate-limit refresh rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refresh = vi.fn(() => Promise.reject(new Error('refresh boom')))
    const invalidateMiniMaxCredentialState = vi.fn()
    registerMiniMaxCredentialsHandlers({
      refresh,
      invalidateMiniMaxCredentialState
    } as Pick<RateLimitService, 'refresh' | 'invalidateMiniMaxCredentialState'> as RateLimitService)
    await invoke('minimaxCredentials:saveCookie', '_token=abc')
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to trigger rate-limit refresh after save'),
      expect.any(Error)
    )
  })

  it('persists the API key and reports apiKeyConfigured after saveApiKey', async () => {
    hasMiniMaxApiKeyMock.mockReturnValueOnce(true)
    registerMiniMaxCredentialsHandlers(null)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:saveApiKey', 'sk-test-1234567890')
    expect(saveMiniMaxApiKeyMock).toHaveBeenCalledWith('sk-test-1234567890')
    expect(status).toMatchObject({ configured: true, apiKeyConfigured: true })
  })

  it('rejects non-string API keys on saveApiKey', async () => {
    registerMiniMaxCredentialsHandlers(null)
    await expect(invoke('minimaxCredentials:saveApiKey', 12345)).rejects.toThrow(/must be a string/)
    expect(saveMiniMaxApiKeyMock).not.toHaveBeenCalled()
  })

  it('triggers a rate-limit refresh after saveApiKey when a service is provided', async () => {
    const { refresh, invalidateMiniMaxCredentialState, service } = makeRefreshMock()
    registerMiniMaxCredentialsHandlers(service as RateLimitService)
    await invoke('minimaxCredentials:saveApiKey', 'sk-test-1234567890')
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('clears the API key and triggers a refresh on clearApiKey', async () => {
    const { refresh, invalidateMiniMaxCredentialState, service } = makeRefreshMock()
    hasMiniMaxApiKeyMock.mockReturnValueOnce(false)
    registerMiniMaxCredentialsHandlers(service as RateLimitService)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:clearApiKey')
    expect(clearMiniMaxApiKeyMock).toHaveBeenCalledTimes(1)
    expect(invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(status).toMatchObject({ configured: false, apiKeyConfigured: false })
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reports configured true when either cookie or API key is set', async () => {
    hasMiniMaxSessionCookieMock.mockReturnValue(true)
    hasMiniMaxApiKeyMock.mockReturnValue(true)
    registerMiniMaxCredentialsHandlers(null)
    const status = await invoke<{
      configured: boolean
      cookieConfigured: boolean
      apiKeyConfigured: boolean
    }>('minimaxCredentials:getStatus')
    expect(status.configured).toBe(true)
    expect(status.cookieConfigured).toBe(true)
    expect(status.apiKeyConfigured).toBe(true)
  })
})
