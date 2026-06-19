import { describe, expect, it } from 'vitest'
import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import {
  getSelectedCodexAccountIdForTarget,
  pruneInvalidCodexRuntimeSelection,
  setSelectedCodexAccountIdForTarget
} from './runtime-selection'

function createSettings(
  overrides: Partial<
    Pick<GlobalSettings, 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'>
  > = {}
): Pick<GlobalSettings, 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'> {
  return {
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} },
    ...overrides
  }
}

function createAccount(
  overrides: Partial<CodexManagedAccount> & Pick<CodexManagedAccount, 'id'>
): CodexManagedAccount {
  const { id, ...rest } = overrides
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `/tmp/${id}`,
    managedHomeRuntime: 'host',
    wslDistro: null,
    wslLinuxHomePath: null,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...rest
  }
}

describe('Codex runtime account selection', () => {
  it('selects host and WSL accounts independently', () => {
    const first = setSelectedCodexAccountIdForTarget({ host: null, wsl: {} }, 'host-account', {
      runtime: 'host'
    })
    const next = setSelectedCodexAccountIdForTarget(first, 'wsl-account', {
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
      activeCodexManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })

    expect(getSelectedCodexAccountIdForTarget(settings, { runtime: 'wsl' })).toBe('wsl-account')
    expect(getSelectedCodexAccountIdForTarget(settings, { runtime: 'host' })).toBe('host-account')
  })

  it('clears WSL selections without clearing the host selection for a WSL default target', () => {
    const next = setSelectedCodexAccountIdForTarget(
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
    const selection = pruneInvalidCodexRuntimeSelection(
      {
        host: 'wsl-account',
        wsl: { Ubuntu: 'host-account', Debian: 'missing-account' }
      },
      [
        createAccount({ id: 'host-account' }),
        createAccount({
          id: 'wsl-account',
          managedHomeRuntime: 'wsl',
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
