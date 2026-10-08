import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const fakes = vi.hoisted(() => ({
  host: {
    prepareLaunch: vi.fn(async () => ({ provenance: 'profile:acct-a' })),
    prepareAccountLaunch: vi.fn(
      async (accountId: string) => `/data/claude-profiles/${accountId}/home`
    ),
    publish: () => {}
  }
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/data' })
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => null, getWslHome: () => null }))
vi.mock('./claude-profile-router', () => ({
  ClaudeProfileRouter: function ClaudeProfileRouter() {
    return fakes.host
  }
}))
vi.mock('./claude-profile-installed-router', () => ({ installClaudeProfileRouter: () => {} }))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

function account(id: string, overrides: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    managedAuthPath: '',
    managedAuthRuntime: 'host',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function service(): ClaudeRuntimeAuthService {
  const settings: GlobalSettings = {
    ...getDefaultSettings('/home/user'),
    claudeManagedAccounts: [
      account('acct-a'),
      account('acct-b'),
      account('acct-w', { managedAuthRuntime: 'wsl' })
    ],
    activeClaudeManagedAccountId: 'acct-a'
  }
  return new ClaudeRuntimeAuthService({ getSettings: () => settings })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ClaudeRuntimeAuthService --account launch', () => {
  it('runs an account that is not the selected one from its own folder, with no pointer', async () => {
    const auth = await service().prepareForClaudeLaunch(undefined, { accountId: 'acct-b' })

    expect(fakes.host.prepareAccountLaunch).toHaveBeenCalledWith('acct-b')
    expect(auth).toMatchObject({
      configDir: '/data/claude-profiles/acct-b/home',
      envPatch: {
        CLAUDE_CONFIG_DIR: '/data/claude-profiles/acct-b/home',
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/data/claude-profiles/acct-b/home'
      },
      stripAuthEnv: true,
      pinnedAccountId: 'acct-b',
      provenance: 'profile:acct-b:pinned'
    })
    expect(auth.envPatch).not.toHaveProperty('ORCA_CLAUDE_PROFILE_POINTER')
  })

  it('sends the selected account down the normal launch path', async () => {
    const auth = await service().prepareForClaudeLaunch(undefined, { accountId: 'acct-a' })

    expect(auth).toEqual({ provenance: 'profile:acct-a' })
    expect(fakes.host.prepareAccountLaunch).not.toHaveBeenCalled()
  })

  it('refuses a missing account and a WSL account before touching any folder', async () => {
    const auth = service()
    await expect(auth.prepareForClaudeLaunch(undefined, { accountId: 'gone' })).rejects.toThrow(
      '[claude_pinned:account-missing]'
    )
    await expect(auth.prepareForClaudeLaunch(undefined, { accountId: 'acct-w' })).rejects.toThrow(
      '[claude_pinned:unsupported-host]'
    )
    expect(fakes.host.prepareAccountLaunch).not.toHaveBeenCalled()
  })
})
