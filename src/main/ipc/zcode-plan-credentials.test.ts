import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerZcodePlanCredentialsHandlers } from './zcode-plan-credentials'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  hasKey: vi.fn(() => false),
  protection: vi.fn<() => 'sealed' | 'plaintext' | null>(() => null),
  hasCli: vi.fn(() => false),
  save: vi.fn(),
  clear: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: mocks.hasKey,
  getZcodePlanApiKeyProtection: mocks.protection,
  saveZcodePlanApiKey: mocks.save,
  clearZcodePlanApiKey: mocks.clear
}))
vi.mock('../rate-limits/zcode-usage-fetcher', () => ({ hasZcodeCliPlanCredentials: mocks.hasCli }))

function handler(channel: string) {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error('Handler missing')
  }
  return registration[1]
}

describe('GLM credential IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasKey.mockReturnValue(false)
    mocks.hasCli.mockReturnValue(false)
    mocks.protection.mockReturnValue(null)
    registerZcodePlanCredentialsHandlers(null)
  })

  it('returns only presence and protection without exposing the key', () => {
    mocks.hasKey.mockReturnValue(true)
    mocks.hasCli.mockReturnValue(true)
    mocks.protection.mockReturnValue('sealed')
    expect(handler('zcodePlanCredentials:getStatus')()).toEqual({
      apiKeyConfigured: true,
      zcodeCliConfigured: true,
      apiKeyProtection: 'sealed'
    })
  })

  it('validates an untyped IPC key before persistence', () => {
    expect(() => handler('zcodePlanCredentials:saveApiKey')(null, 42)).toThrow('must be a string')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('saves and removes keys while returning status only', () => {
    mocks.save.mockImplementationOnce(() => mocks.hasKey.mockReturnValue(true))
    mocks.clear.mockImplementationOnce(() => mocks.hasKey.mockReturnValue(false))
    expect(handler('zcodePlanCredentials:saveApiKey')(null, 'synthetic-key')).toEqual({
      apiKeyConfigured: true,
      zcodeCliConfigured: false,
      apiKeyProtection: null
    })
    expect(handler('zcodePlanCredentials:clearApiKey')()).toEqual({
      apiKeyConfigured: false,
      zcodeCliConfigured: false,
      apiKeyProtection: null
    })
  })
})
