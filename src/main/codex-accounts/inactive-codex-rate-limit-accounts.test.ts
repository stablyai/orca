import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import { getInactiveCodexRateLimitAccounts } from './inactive-codex-rate-limit-accounts'

function makeAccount(
  id: string,
  overrides: Partial<CodexManagedAccount> = {}
): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `/tmp/orca/codex-accounts/${id}/home`,
    managedHomeRuntime: 'host',
    wslDistro: null,
    wslLinuxHomePath: null,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function makeSettings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...getDefaultSettings('/tmp'),
    ...overrides
  }
}

describe('getInactiveCodexRateLimitAccounts', () => {
  it('returns inactive host managed accounts when default-home mode is off', () => {
    const settings = makeSettings({
      codexManagedAccounts: [makeAccount('active-host'), makeAccount('inactive-host')],
      activeCodexManagedAccountId: 'active-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'active-host', wsl: {} },
      codexUseDefaultConfigDir: false
    })

    expect(getInactiveCodexRateLimitAccounts(settings)).toEqual([
      { id: 'inactive-host', managedHomePath: '/tmp/orca/codex-accounts/inactive-host/home' }
    ])
  })

  it('skips host managed homes when default-home mode is on but keeps WSL previews', () => {
    const wslHome = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex\\home'
    const settings = makeSettings({
      codexManagedAccounts: [
        makeAccount('active-host'),
        makeAccount('inactive-host'),
        makeAccount('inactive-wsl', {
          managedHomePath: wslHome,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex/home'
        })
      ],
      activeCodexManagedAccountId: 'active-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'active-host', wsl: {} },
      codexUseDefaultConfigDir: true
    })

    expect(getInactiveCodexRateLimitAccounts(settings)).toEqual([
      { id: 'inactive-wsl', managedHomePath: wslHome }
    ])
  })
})
