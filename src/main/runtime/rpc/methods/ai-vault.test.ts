import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_METHODS } from './ai-vault'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessions: vi.fn()
}))

vi.mock('../../../ai-vault/session-scanner', () => ({
  scanAiVaultSessions: mocks.scanAiVaultSessions
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scanAiVaultSessions.mockResolvedValue({
    sessions: [],
    issues: [],
    scannedAt: '2026-07-04T00:00:00.000Z'
  })
})

describe('aiVault.listSessions runtime RPC', () => {
  it('scans server-local sessions under the caller supplied runtime host id', async () => {
    const method = AI_VAULT_METHODS.find((entry) => entry.name === 'aiVault.listSessions')
    expect(method).toBeDefined()

    const params = method!.params!.parse({
      limit: 25,
      scopePaths: ['/srv/app'],
      executionHostId: 'runtime:remote-server'
    })

    await method!.handler(params, {} as never)

    expect(mocks.scanAiVaultSessions).toHaveBeenCalledWith({
      limit: 25,
      scopePaths: ['/srv/app'],
      executionHostId: 'runtime:remote-server'
    })
  })

  it('rejects non-runtime execution host ids before dispatch', () => {
    const method = AI_VAULT_METHODS.find((entry) => entry.name === 'aiVault.listSessions')
    expect(method).toBeDefined()

    expect(() =>
      method!.params!.parse({
        executionHostId: 'not-a-runtime-host'
      })
    ).toThrow('Invalid runtime execution host id')
    expect(() =>
      method!.params!.parse({
        executionHostId: 'local'
      })
    ).toThrow('Invalid runtime execution host id')
    expect(() =>
      method!.params!.parse({
        executionHostId: 'ssh:dev-box'
      })
    ).toThrow('Invalid runtime execution host id')
  })
})
