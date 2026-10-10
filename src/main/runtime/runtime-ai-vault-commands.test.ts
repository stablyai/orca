import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ local: vi.fn(), ssh: vi.fn() }))
vi.mock('../ai-vault/cached-session-list', () => ({ listAiVaultSessions: mocks.local }))
vi.mock('../host/ai-vault-ssh-host-port', () => ({ listSshHostScopeAiVaultSessions: mocks.ssh }))

import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'

describe('RuntimeAiVaultCommands.list', () => {
  beforeEach(() => {
    mocks.local.mockReset().mockResolvedValue({ sessions: [], issues: [] })
    mocks.ssh.mockReset().mockResolvedValue({ sessions: [], issues: [] })
  })

  it('routes a single SSH scope to that host and keeps everything else on the local scan', async () => {
    const commands = new RuntimeAiVaultCommands(() => null)
    await commands.list({ executionHostScope: 'ssh:builder', limit: 3 })
    expect(mocks.ssh).toHaveBeenCalledWith('builder', {
      executionHostScope: 'ssh:builder',
      limit: 3
    })
    expect(mocks.local).not.toHaveBeenCalled()

    for (const executionHostScope of [undefined, 'local', 'all', 'runtime:devbox'] as const) {
      await commands.list(executionHostScope ? { executionHostScope } : {})
    }
    expect(mocks.local).toHaveBeenCalledTimes(4)
    expect(mocks.ssh).toHaveBeenCalledTimes(1)
  })
})
