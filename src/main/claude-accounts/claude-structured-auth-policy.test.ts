import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { isHostManagedClaudeAccount } from './environment'

import { claudeStructuredAuthPolicyForSettings } from './claude-structured-auth-policy'

const HOST_ACCOUNT = { id: 'host-a', managedAuthRuntime: 'host' } as ClaudeManagedAccount
const WSL_ACCOUNT = { id: 'wsl-b', managedAuthRuntime: 'wsl' } as ClaudeManagedAccount
const LEGACY_ACCOUNT = { id: 'legacy-c' } as ClaudeManagedAccount

function settings(
  overrides: Partial<
    Pick<
      GlobalSettings,
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
): Parameters<typeof claudeStructuredAuthPolicyForSettings>[0] {
  return {
    claudeManagedAccounts: [HOST_ACCOUNT, WSL_ACCOUNT, LEGACY_ACCOUNT],
    activeClaudeManagedAccountId: null,
    ...overrides
  } as Parameters<typeof claudeStructuredAuthPolicyForSettings>[0]
}

describe('isHostManagedClaudeAccount', () => {
  it('is true for a selected id no account list explains', () => {
    expect(isHostManagedClaudeAccount([HOST_ACCOUNT], 'deleted-d')).toBe(true)
    expect(isHostManagedClaudeAccount(undefined, 'deleted-d')).toBe(true)
    expect(isHostManagedClaudeAccount([], 'deleted-d')).toBe(true)
  })
})

describe('claudeStructuredAuthPolicyForSettings', () => {
  it('reads the host runtime selection, not the legacy flat field alone', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountId: 'host-a',
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
        })
      )
    ).toEqual({ account: 'managed' })
  })

  it('ignores a WSL-only selection: the structured child is always a native host process', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-b' } }
        })
      )
    ).toEqual({ account: 'system' })
  })
})
