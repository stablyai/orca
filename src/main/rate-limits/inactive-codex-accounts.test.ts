import { describe, expect, it } from 'vitest'
import type { CodexManagedAccount } from '../../shared/agent-accounts/managed-account-types'
import { resolveInactiveCodexAccounts } from './inactive-codex-accounts'

function account(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `/managed/${id}`,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function inactiveIds(hostSelection: string | null, wslSelection: string | null): string[] {
  return resolveInactiveCodexAccounts(
    {
      codexManagedAccounts: [account('work'), account('personal')],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: hostSelection,
        wsl: wslSelection ? { Ubuntu: wslSelection } : {}
      }
    },
    (managed) => ({ kind: 'ready', homePath: managed.managedHomePath })
  ).map((entry) => entry.id)
}

describe('resolveInactiveCodexAccounts', () => {
  it('previews the host System default only while a saved host account is selected', () => {
    expect(inactiveIds('work', null)).toEqual(['codex-system-default', 'personal'])
    expect(inactiveIds(null, null)).toEqual(['work', 'personal'])
    expect(inactiveIds(null, 'work')).toEqual(['personal'])
  })
})
