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

const saveFactoryApiKeyMock = vi.hoisted(() => vi.fn())
const clearFactoryApiKeyMock = vi.hoisted(() => vi.fn())
const getFactoryAccountStatusMock = vi.hoisted(() => {
  const fn = vi.fn(() => ({
    configured: false,
    source: null as string | null,
    error: null as string | null
  }))
  return fn
})

vi.mock('../factory/factory-api-key-store', () => ({
  saveFactoryApiKey: saveFactoryApiKeyMock,
  clearFactoryApiKey: clearFactoryApiKeyMock
}))

vi.mock('../factory-accounts/status', () => ({
  getFactoryAccountStatus: getFactoryAccountStatusMock
}))

import { registerFactoryAccountHandlers } from './factory-accounts'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitState } from '../../shared/rate-limit-types'

function makeRefreshMock(): {
  refresh: ReturnType<typeof vi.fn>
  invalidateFactoryCredentialState: ReturnType<typeof vi.fn>
  service: Pick<RateLimitService, 'refresh' | 'invalidateFactoryCredentialState'>
} {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const invalidateFactoryCredentialState = vi.fn()
  return {
    refresh,
    invalidateFactoryCredentialState,
    service: { refresh, invalidateFactoryCredentialState }
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return (await handler({}, ...args)) as T
}

describe('registerFactoryAccountHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
    saveFactoryApiKeyMock.mockReset()
    clearFactoryApiKeyMock.mockReset()
    getFactoryAccountStatusMock.mockReset()
    getFactoryAccountStatusMock.mockReturnValue({ configured: false, source: null, error: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers the three Factory account channels', () => {
    registerFactoryAccountHandlers(null)
    expect(ipcState.handleHandlers.has('factoryAccounts:getStatus')).toBe(true)
    expect(ipcState.handleHandlers.has('factoryAccounts:saveApiKey')).toBe(true)
    expect(ipcState.handleHandlers.has('factoryAccounts:clearApiKey')).toBe(true)
  })

  it('returns the account status on getStatus', async () => {
    getFactoryAccountStatusMock.mockReturnValue({ configured: true, source: 'orca', error: null })
    registerFactoryAccountHandlers(null)
    const status = await invoke<{ configured: boolean; source: string | null }>(
      'factoryAccounts:getStatus'
    )
    expect(status).toEqual({ configured: true, source: 'orca', error: null })
  })

  it('persists the key and reports status after saveApiKey', async () => {
    getFactoryAccountStatusMock.mockReturnValue({ configured: true, source: 'orca', error: null })
    registerFactoryAccountHandlers(null)
    const status = await invoke<{ configured: boolean }>('factoryAccounts:saveApiKey', 'fk-new-key')
    expect(saveFactoryApiKeyMock).toHaveBeenCalledWith('fk-new-key')
    expect(status).toEqual({ configured: true, source: 'orca', error: null })
  })

  it('rejects a non-string key argument', async () => {
    registerFactoryAccountHandlers(null)
    await expect(invoke('factoryAccounts:saveApiKey', 42)).rejects.toThrow(
      'Factory API key must be a string'
    )
    expect(saveFactoryApiKeyMock).not.toHaveBeenCalled()
  })

  it('invalidates and refreshes rate limits after save when a service is provided', async () => {
    const { refresh, invalidateFactoryCredentialState, service } = makeRefreshMock()
    registerFactoryAccountHandlers(service as RateLimitService)
    await invoke('factoryAccounts:saveApiKey', 'fk-new-key')
    // Why: the save handler is fire-and-forget — wait a microtask cycle so
    // the queued `void rateLimits?.refresh()` resolves before we assert.
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateFactoryCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('clears the key and refreshes after clearApiKey', async () => {
    const { refresh, invalidateFactoryCredentialState, service } = makeRefreshMock()
    registerFactoryAccountHandlers(service as RateLimitService)
    await invoke('factoryAccounts:clearApiKey')
    expect(clearFactoryApiKeyMock).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateFactoryCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not throw when save runs without a rate-limit service', async () => {
    registerFactoryAccountHandlers(null)
    await expect(invoke('factoryAccounts:saveApiKey', 'fk-new-key')).resolves.toBeDefined()
  })
})
