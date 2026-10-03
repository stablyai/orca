import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const login = vi.hoisted((): { cancelled: string[] } => ({ cancelled: [] }))
vi.mock('./claude-profile-login', () => ({
  prepareClaudeProfileLogin: async (id: string) => ({
    config: { windowsPath: `/profiles/${id}/home`, linuxPath: null, wslDistro: null },
    provision: async () => {}
  }),
  // A sign-in the user never finishes: only a superseding action ends it.
  loginToClaudeProfile: (
    config: { windowsPath: string },
    setCancel: (cancel: (() => boolean) | null) => void
  ) =>
    new Promise<void>((_resolve, reject) => {
      setCancel(() => {
        login.cancelled.push(config.windowsPath)
        reject(new Error('Claude sign-in was cancelled.'))
        return true
      })
    }).finally(() => setCancel(null))
}))

import { ClaudeAccountService } from './service'

function account(id: string, runtime: 'host' | 'wsl'): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    managedAuthPath: '',
    managedAuthRuntime: runtime,
    wslDistro: runtime === 'wsl' ? 'Ubuntu' : null,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function fixture() {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [account('a', 'host'), account('b', 'host'), account('w', 'wsl')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
  }
  const runtimeAuth = {
    syncForCurrentSelection: vi.fn(async () => {}),
    forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
    getRuntimeConfigDir: () => '/unused'
  }
  const service = new ClaudeAccountService(
    {
      getSettings: () => settings,
      updateSettings: (patch: Partial<GlobalSettings>) => {
        settings = { ...settings, ...patch }
        return settings
      }
    },
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    runtimeAuth
  )
  return { service, runtimeAuth, settings: () => settings }
}

describe('ClaudeAccountService', () => {
  beforeEach(() => {
    login.cancelled.length = 0
  })

  it('puts the previous account back when publishing a new selection fails', async () => {
    const f = fixture()
    f.runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
    await expect(f.service.selectAccount('b')).rejects.toThrow('publish failed')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    expect(f.runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalledWith({
      runtime: 'host'
    })
  })

  it('refuses to select a WSL account for the host', async () => {
    const f = fixture()
    await expect(f.service.selectAccountForTarget('w', { runtime: 'host' })).rejects.toThrow(
      'That Claude account belongs to a different runtime.'
    )
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
  })

  it("selects and removes a WSL account without touching the host's, starting its distro", async () => {
    const f = fixture()
    const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    await f.service.selectAccountForTarget('w', ubuntu)
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime).toMatchObject({
      host: 'a',
      wsl: { Ubuntu: 'w' }
    })
    expect(f.runtimeAuth.syncForCurrentSelection).toHaveBeenLastCalledWith(ubuntu, 'boot')
    await f.service.removeAccount('w')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    expect(f.runtimeAuth.syncForCurrentSelection).toHaveBeenLastCalledWith(ubuntu, 'boot')
  })

  it('ends an abandoned sign-in when the user starts another account action', async () => {
    const f = fixture()
    const adding = f.service.addAccount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(f.service.selectAccount('b')).resolves.toHaveProperty('accounts')
    await expect(adding).rejects.toThrow('Claude sign-in was cancelled.')
    expect(login.cancelled).toHaveLength(1)
    expect(f.service.cancelPendingLogin()).toBe(false)
  })
})
