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

const saveZaiApiKeyMock = vi.hoisted(() => vi.fn())
const clearZaiApiKeyMock = vi.hoisted(() => vi.fn())
const hasZaiApiKeyMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('../zai/zai-api-key-store', () => ({
  saveZaiApiKey: saveZaiApiKeyMock,
  clearZaiApiKey: clearZaiApiKeyMock,
  hasZaiApiKey: hasZaiApiKeyMock
}))

import { registerZaiCredentialsHandlers } from './zai-credentials'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitState } from '../../shared/rate-limit-types'

function makeRefreshMock(): {
  refresh: ReturnType<typeof vi.fn>
  invalidateZaiCredentialState: ReturnType<typeof vi.fn>
  service: Pick<RateLimitService, 'refresh' | 'invalidateZaiCredentialState'>
} {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const invalidateZaiCredentialState = vi.fn()
  return {
    refresh,
    invalidateZaiCredentialState,
    service: { refresh, invalidateZaiCredentialState }
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return (await handler({}, ...args)) as T
}

describe('registerZaiCredentialsHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
    saveZaiApiKeyMock.mockReset()
    clearZaiApiKeyMock.mockReset()
    hasZaiApiKeyMock.mockReset()
    hasZaiApiKeyMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers the three Z.ai credential channels', () => {
    registerZaiCredentialsHandlers(null)
    expect(ipcState.handleHandlers.has('zaiCredentials:getStatus')).toBe(true)
    expect(ipcState.handleHandlers.has('zaiCredentials:saveApiKey')).toBe(true)
    expect(ipcState.handleHandlers.has('zaiCredentials:clearApiKey')).toBe(true)
  })

  it('returns the configured state on getStatus', async () => {
    hasZaiApiKeyMock.mockReturnValue(true)
    registerZaiCredentialsHandlers(null)
    const status = await invoke<{ configured: boolean }>('zaiCredentials:getStatus')
    expect(status).toEqual({ configured: true })
  })

  it('trims and persists the API key on save', async () => {
    hasZaiApiKeyMock.mockReturnValueOnce(true)
    registerZaiCredentialsHandlers(null)
    const status = await invoke<{ configured: boolean }>('zaiCredentials:saveApiKey', '  glm-key  ')
    expect(saveZaiApiKeyMock).toHaveBeenCalledWith('glm-key')
    expect(status).toEqual({ configured: true })
  })

  it('rejects empty API keys', async () => {
    registerZaiCredentialsHandlers(null)
    await expect(invoke('zaiCredentials:saveApiKey', '   ')).rejects.toThrow(/required/i)
  })

  it('rejects oversized API keys before persisting', async () => {
    registerZaiCredentialsHandlers(null)
    await expect(invoke('zaiCredentials:saveApiKey', 'a'.repeat(4097))).rejects.toThrow(/at most/i)
    expect(saveZaiApiKeyMock).not.toHaveBeenCalled()
  })

  it('rejects API keys with control characters before persisting', async () => {
    registerZaiCredentialsHandlers(null)
    await expect(invoke('zaiCredentials:saveApiKey', 'abc\nxyz')).rejects.toThrow(
      /control characters/i
    )
    expect(saveZaiApiKeyMock).not.toHaveBeenCalled()
  })

  it('refreshes rate limits after saving the API key', async () => {
    const { refresh, invalidateZaiCredentialState, service } = makeRefreshMock()
    registerZaiCredentialsHandlers(service as RateLimitService)
    await invoke('zaiCredentials:saveApiKey', 'glm-key')
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateZaiCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('clears the API key and refreshes rate limits', async () => {
    const { refresh, invalidateZaiCredentialState, service } = makeRefreshMock()
    registerZaiCredentialsHandlers(service as RateLimitService)
    const status = await invoke<{ configured: boolean }>('zaiCredentials:clearApiKey')
    await new Promise((resolve) => setImmediate(resolve))
    expect(clearZaiApiKeyMock).toHaveBeenCalledTimes(1)
    expect(invalidateZaiCredentialState).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(status).toEqual({ configured: false })
  })

  it('logs but does not throw when the post-save refresh rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refresh = vi.fn(() => Promise.reject(new Error('refresh boom')))
    const invalidateZaiCredentialState = vi.fn()
    registerZaiCredentialsHandlers({
      refresh,
      invalidateZaiCredentialState
    } as Pick<RateLimitService, 'refresh' | 'invalidateZaiCredentialState'> as RateLimitService)
    await invoke('zaiCredentials:saveApiKey', 'glm-key')
    await new Promise((resolve) => setImmediate(resolve))
    expect(invalidateZaiCredentialState).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to trigger rate-limit refresh after save'),
      expect.any(Error)
    )
  })
})
