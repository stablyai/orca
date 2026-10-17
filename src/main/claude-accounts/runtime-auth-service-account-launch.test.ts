import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const fakes = vi.hoisted(() => ({
  prepareClaudePinnedAccountLaunch: vi.fn(
    async (_router: unknown, _dataRoot: string, accountId: string) => ({
      provenance: `profile:${accountId}:pinned`
    })
  ),
  host: {
    prepareLaunch: vi.fn(async () => ({ provenance: 'profile:acct-a' })),
    coveredBySystemDefault: vi.fn(() => true),
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
vi.mock('./claude-pinned-account-launch', () => ({
  prepareClaudePinnedAccountLaunch: fakes.prepareClaudePinnedAccountLaunch
}))
vi.mock('./claude-profile-installed-router', () => ({
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))

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
  it('runs an account that is not the selected one on its own pinned preparation', async () => {
    const auth = await service().prepareForClaudeLaunch(undefined, { accountId: 'acct-b' })

    expect(fakes.prepareClaudePinnedAccountLaunch).toHaveBeenCalledWith(
      fakes.host,
      '/data',
      'acct-b'
    )
    expect(auth).toEqual({ provenance: 'profile:acct-b:pinned' })
  })

  it('sends the selected account down the normal launch path', async () => {
    const auth = await service().prepareForClaudeLaunch(undefined, { accountId: 'acct-a' })

    expect(auth).toEqual({ provenance: 'profile:acct-a' })
    expect(fakes.prepareClaudePinnedAccountLaunch).not.toHaveBeenCalled()
  })

  it('names the selected account when System default holds its login', async () => {
    fakes.host.prepareLaunch.mockResolvedValueOnce({ provenance: 'system' })

    const auth = await service().prepareForClaudeLaunch(undefined, { accountId: 'acct-a' })

    expect(auth).toEqual({ provenance: 'profile:acct-a' })

    fakes.host.prepareLaunch.mockResolvedValueOnce({ provenance: 'system' })
    fakes.host.coveredBySystemDefault.mockReturnValueOnce(false)
    await expect(
      service().prepareForClaudeLaunch(undefined, { accountId: 'acct-a' })
    ).resolves.toEqual({ provenance: 'system' })
  })

  it('refuses a missing account and a WSL account before touching any folder', async () => {
    const auth = service()
    await expect(auth.prepareForClaudeLaunch(undefined, { accountId: 'gone' })).rejects.toThrow(
      '[claude_pinned:account-missing]'
    )
    await expect(auth.prepareForClaudeLaunch(undefined, { accountId: 'acct-w' })).rejects.toThrow(
      '[claude_pinned:unsupported-host]'
    )
    expect(fakes.prepareClaudePinnedAccountLaunch).not.toHaveBeenCalled()
  })
})
