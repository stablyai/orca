import { describe, expect, it, vi } from 'vitest'
import { opencodeGoCredentialsApi } from './api/opencode-go-credentials-bridge'

const invoke = vi.hoisted(() => vi.fn(async () => ({ apiKeyConfigured: true })))
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

describe('OpenCode Go credential bridge', () => {
  it('exposes only status and write operations', async () => {
    expect(await opencodeGoCredentialsApi.getStatus()).toEqual({ apiKeyConfigured: true })
    await opencodeGoCredentialsApi.saveApiKey('fake-key')
    await opencodeGoCredentialsApi.clearApiKey()
    expect(invoke.mock.calls).toEqual([
      ['opencodeGoCredentials:getStatus'],
      ['opencodeGoCredentials:saveApiKey', 'fake-key'],
      ['opencodeGoCredentials:clearApiKey']
    ])
    expect(Object.keys(opencodeGoCredentialsApi)).toEqual([
      'getStatus',
      'saveApiKey',
      'clearApiKey'
    ])
  })
})
