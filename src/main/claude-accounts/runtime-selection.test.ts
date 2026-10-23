import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  getSelectedClaudeAccountIdForTarget,
  pruneInvalidClaudeRuntimeSelection,
  setSelectedClaudeAccountIdForTarget
} from './runtime-selection'

function createSettings(
  overrides: Partial<
    Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
  > = {}
): Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'> {
  return {
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    ...overrides
  }
}

function createAccount(
  overrides: Partial<ClaudeManagedAccount> & Pick<ClaudeManagedAccount, 'id'>
): ClaudeManagedAccount {
  const { id, ...rest } = overrides
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/tmp/${id}`,
    managedAuthRuntime: 'host',
    wslDistro: null,
    wslLinuxAuthPath: null,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...rest
  }
}

describe('Claude runtime account selection', () => {
  it('reads legacy distro spelling without changing the selection or launch target', () => {
    const settings = createSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account', Debian: 'debian-account' }
      }
    })
    for (const wslDistro of ['Ubuntu', 'ubuntu', ' UBUNTU ']) {
      expect(getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro })).toBe(
        'wsl-account'
      )
    }
    expect(
      getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro: 'Fedora' })
    ).toBeNull()
    expect(settings.activeClaudeManagedAccountIdsByRuntime?.wsl).toEqual({
      Ubuntu: 'wsl-account',
      Debian: 'debian-account'
    })
  })

  it('updates every saved alias while preserving their spelling and unrelated runtimes', () => {
    const selection = { host: 'host-account', wsl: { Ubuntu: 'a', ubuntu: 'a', Debian: 'd' } }
    const changed = setSelectedClaudeAccountIdForTarget(selection, 'b', {
      runtime: 'wsl',
      wslDistro: 'UBUNTU'
    })
    expect(changed).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'b', ubuntu: 'b', Debian: 'd' }
    })
    expect(
      setSelectedClaudeAccountIdForTarget(changed, null, { runtime: 'wsl', wslDistro: 'ubuntu' })
    ).toEqual({ host: 'host-account', wsl: { Ubuntu: null, ubuntu: null, Debian: 'd' } })
    expect(selection.wsl.Ubuntu).toBe('a')
  })

  it('keeps exact legacy spellings and does not choose between conflicting aliases', () => {
    for (const wsl of [
      { Ubuntu: 'a', ubuntu: 'b' },
      { Ubuntu: 'a', ubuntu: null }
    ]) {
      const settings = createSettings({
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl }
      })
      const lookup = (wslDistro: string) =>
        getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro })
      expect(lookup('Ubuntu')).toBe('a')
      expect(lookup('ubuntu')).toBe(wsl.ubuntu)
      expect(lookup('UBUNTU')).toBeNull()
    }
  })

  it('retains selections when account and legacy map distro casing differ', () => {
    expect(
      pruneInvalidClaudeRuntimeSelection({ host: null, wsl: { ubuntu: 'a', Debian: 'a' } }, [
        createAccount({ id: 'a', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
      ])
    ).toEqual({ host: null, wsl: { ubuntu: 'a', Debian: null } })
  })

  it('selects host and WSL accounts independently', () => {
    const first = setSelectedClaudeAccountIdForTarget({ host: null, wsl: {} }, 'host-account', {
      runtime: 'host'
    })
    const next = setSelectedClaudeAccountIdForTarget(first, 'wsl-account', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(next).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
  })

  it('resolves a WSL default target when exactly one WSL distro has a selection', () => {
    const settings = createSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })

    expect(getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl' })).toBe('wsl-account')
    expect(getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })).toBe('host-account')
  })

  it('clears WSL selections without clearing the host selection for a WSL default target', () => {
    const next = setSelectedClaudeAccountIdForTarget(
      {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account', Debian: 'other-wsl-account' }
      },
      null,
      { runtime: 'wsl' }
    )

    expect(next).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: null, Debian: null }
    })
  })

  it('drops selections whose account belongs to another runtime', () => {
    const selection = pruneInvalidClaudeRuntimeSelection(
      {
        host: 'wsl-account',
        wsl: { Ubuntu: 'host-account', Debian: 'missing-account' }
      },
      [
        createAccount({ id: 'host-account' }),
        createAccount({
          id: 'wsl-account',
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu'
        })
      ]
    )

    expect(selection).toEqual({
      host: null,
      wsl: { Ubuntu: null, Debian: null }
    })
  })
})
