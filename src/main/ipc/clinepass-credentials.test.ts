import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClinePassCredentialsStatus } from '../../shared/clinepass-credentials'
import type { RateLimitState } from '../../shared/rate-limit-types'
import type { RateLimitService } from '../rate-limits/service'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

const isTrustedUIRendererMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

const saveClinePassApiKeyMock = vi.hoisted(() => vi.fn())
const clearClinePassApiKeyMock = vi.hoisted(() => vi.fn())
const getClinePassCredentialsStatusMock = vi.hoisted(() =>
  vi.fn((): ClinePassCredentialsStatus => ({ configured: false, source: 'none' }))
)

vi.mock('../clinepass/clinepass-api-key-store', () => ({
  saveClinePassApiKey: saveClinePassApiKeyMock,
  clearClinePassApiKey: clearClinePassApiKeyMock,
  getClinePassCredentialsStatus: getClinePassCredentialsStatusMock
}))

import { registerClinePassCredentialsHandlers } from './clinepass-credentials'

function makeRefreshMock(): {
  refresh: ReturnType<typeof vi.fn>
  invalidateClinePassCredentialState: ReturnType<typeof vi.fn>
  service: Pick<RateLimitService, 'refresh' | 'invalidateClinePassCredentialState'>
} {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const invalidateClinePassCredentialState = vi.fn()
  return {
    refresh,
    invalidateClinePassCredentialState,
    service: { refresh, invalidateClinePassCredentialState }
  }
}

const trustedEvent = { sender: { id: 1 } }
const untrustedEvent = { sender: { id: 99 } }

async function invokeWithEvent<T>(
  channel: string,
  event: { sender: { id: number } },
  ...args: unknown[]
): Promise<T> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return (await handler(event, ...args)) as T
}

async function invokeTrusted<T>(channel: string, ...args: unknown[]): Promise<T> {
  isTrustedUIRendererMock.mockReturnValue(true)
  return invokeWithEvent<T>(channel, trustedEvent, ...args)
}

describe('registerClinePassCredentialsHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
    saveClinePassApiKeyMock.mockReset()
    clearClinePassApiKeyMock.mockReset()
    getClinePassCredentialsStatusMock.mockReset()
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: false, source: 'none' })
    isTrustedUIRendererMock.mockReset()
    isTrustedUIRendererMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers the three ClinePass credential channels', () => {
    registerClinePassCredentialsHandlers(null)
    expect(ipcState.handleHandlers.has('clinePassCredentials:getStatus')).toBe(true)
    expect(ipcState.handleHandlers.has('clinePassCredentials:saveApiKey')).toBe(true)
    expect(ipcState.handleHandlers.has('clinePassCredentials:clearApiKey')).toBe(true)
  })

  it('returns status on getStatus without exposing the key', async () => {
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: true, source: 'environment' })
    registerClinePassCredentialsHandlers(null)
    const status = await invokeTrusted<ClinePassCredentialsStatus>('clinePassCredentials:getStatus')
    expect(status).toEqual({ configured: true, source: 'environment' })
    expect(status).not.toHaveProperty('apiKey')
    expect(isTrustedUIRendererMock).toHaveBeenCalledWith(trustedEvent.sender)
  })

  it('persists the key and reports stored status after saveApiKey', async () => {
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: true, source: 'stored' })
    registerClinePassCredentialsHandlers(null)
    const status = await invokeTrusted<ClinePassCredentialsStatus>(
      'clinePassCredentials:saveApiKey',
      'cp_live_abc'
    )
    expect(saveClinePassApiKeyMock).toHaveBeenCalledWith('cp_live_abc')
    expect(status).toEqual({ configured: true, source: 'stored' })
    expect(status).not.toHaveProperty('apiKey')
  })

  it('rejects non-string saveApiKey arguments', async () => {
    registerClinePassCredentialsHandlers(null)
    await expect(invokeTrusted('clinePassCredentials:saveApiKey', 42)).rejects.toThrow(
      /must be a string/
    )
    expect(saveClinePassApiKeyMock).not.toHaveBeenCalled()
  })

  it('triggers invalidate + background refresh after saveApiKey when a service is provided', async () => {
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: true, source: 'stored' })
    const { refresh, invalidateClinePassCredentialState, service } = makeRefreshMock()
    registerClinePassCredentialsHandlers(service as RateLimitService)
    await invokeTrusted('clinePassCredentials:saveApiKey', 'cp_live_abc')
    // Why: the save handler is fire-and-forget — wait a microtask cycle so
    // the queued `void rateLimits?.refresh()` resolves before we assert.
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateClinePassCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not throw when saveApiKey runs without a rate-limit service', async () => {
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: true, source: 'stored' })
    registerClinePassCredentialsHandlers(null)
    await expect(
      invokeTrusted('clinePassCredentials:saveApiKey', 'cp_live_abc')
    ).resolves.toBeDefined()
  })

  it('clears the key and triggers a refresh on clearApiKey', async () => {
    const { refresh, invalidateClinePassCredentialState, service } = makeRefreshMock()
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: false, source: 'none' })
    registerClinePassCredentialsHandlers(service as RateLimitService)
    const status = await invokeTrusted<ClinePassCredentialsStatus>(
      'clinePassCredentials:clearApiKey'
    )
    expect(clearClinePassApiKeyMock).toHaveBeenCalledTimes(1)
    expect(invalidateClinePassCredentialState).toHaveBeenCalledTimes(1)
    expect(status).toEqual({ configured: false, source: 'none' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('logs but does not throw when the post-save rate-limit refresh rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    getClinePassCredentialsStatusMock.mockReturnValue({ configured: true, source: 'stored' })
    const refresh = vi.fn(() => Promise.reject(new Error('refresh boom')))
    const invalidateClinePassCredentialState = vi.fn()
    registerClinePassCredentialsHandlers({
      refresh,
      invalidateClinePassCredentialState
    } as Pick<
      RateLimitService,
      'refresh' | 'invalidateClinePassCredentialState'
    > as RateLimitService)
    await invokeTrusted('clinePassCredentials:saveApiKey', 'cp_live_abc')
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateClinePassCredentialState).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to trigger rate-limit refresh after save'),
      expect.any(Error)
    )
  })

  it.each([
    ['clinePassCredentials:getStatus', [] as unknown[]],
    ['clinePassCredentials:saveApiKey', ['cp_live_abc'] as unknown[]],
    ['clinePassCredentials:clearApiKey', [] as unknown[]]
  ] as const)(
    'rejects untrusted senders on %s without touching credentials or refresh',
    async (channel, args) => {
      const { refresh, invalidateClinePassCredentialState, service } = makeRefreshMock()
      registerClinePassCredentialsHandlers(service as RateLimitService)
      isTrustedUIRendererMock.mockReturnValue(false)

      await expect(invokeWithEvent(channel, untrustedEvent, ...args)).rejects.toThrow(
        /Unauthorized ClinePass credentials sender/
      )

      expect(isTrustedUIRendererMock).toHaveBeenCalledWith(untrustedEvent.sender)
      expect(getClinePassCredentialsStatusMock).not.toHaveBeenCalled()
      expect(saveClinePassApiKeyMock).not.toHaveBeenCalled()
      expect(clearClinePassApiKeyMock).not.toHaveBeenCalled()
      expect(invalidateClinePassCredentialState).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
    }
  )
})
