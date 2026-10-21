import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { registerOpenCodeGoCredentialsHandlers } from './opencode-go-credentials'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, key?: unknown) => unknown>(),
  has: vi.fn(() => false),
  save: vi.fn(),
  clear: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, key?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../opencode/opencode-go-api-key-store', () => ({
  hasOpenCodeGoApiKey: mocks.has,
  saveOpenCodeGoApiKey: mocks.save,
  clearOpenCodeGoApiKey: mocks.clear
}))

function invoke(action: string, value?: unknown): unknown {
  const handler = mocks.handlers.get(`opencodeGoCredentials:${action}`)
  if (!handler) {
    throw new Error('Missing credential handler')
  }
  return handler({}, value)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
})

describe('OpenCode Go write-only credentials', () => {
  it('returns only boolean status and provides no key reader', () => {
    registerOpenCodeGoCredentialsHandlers(null)
    mocks.has.mockReturnValue(true)
    expect(invoke('getStatus')).toEqual({ apiKeyConfigured: true })
    expect([...mocks.handlers.keys()]).toEqual([
      'opencodeGoCredentials:getStatus',
      'opencodeGoCredentials:saveApiKey',
      'opencodeGoCredentials:clearApiKey'
    ])
  })

  it.each(['saveApiKey', 'clearApiKey'])('invalidates before refreshing on %s', (action) => {
    const invalidate = vi.fn()
    const refresh = vi.fn(async () => {
      expect(invalidate).toHaveBeenCalledOnce()
      return createEmptyRateLimitState()
    })
    registerOpenCodeGoCredentialsHandlers({
      invalidateOpenCodeGoCredentialState: invalidate,
      refresh
    })
    mocks.has.mockReturnValue(action === 'saveApiKey')
    expect(invoke(action, 'fake-key')).toEqual({ apiKeyConfigured: action === 'saveApiKey' })
    expect(action === 'saveApiKey' ? mocks.save : mocks.clear).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    // Why: only clearing the saved key may hide the chip; another key source can still exist after a save.
    expect(invalidate).toHaveBeenCalledWith({ apiKeyCleared: action === 'clearApiKey' })
  })

  it.each([null, undefined, 42, {}])('rejects a non-string key', (key) => {
    registerOpenCodeGoCredentialsHandlers(null)
    expect(() => invoke('saveApiKey', key)).toThrow('OpenCode Go API key must be a string')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not refresh after a failed save', () => {
    const invalidate = vi.fn()
    const refresh = vi.fn()
    registerOpenCodeGoCredentialsHandlers({
      invalidateOpenCodeGoCredentialState: invalidate,
      refresh
    })
    mocks.save.mockImplementation(() => {
      throw new Error('Could not save credential')
    })
    expect(() => invoke('saveApiKey', 'fake-key')).toThrow('Could not save credential')
    expect(invalidate).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
