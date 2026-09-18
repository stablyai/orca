import { describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { getClaudeManagedAccountLabel } from '../../shared/claude-managed-account-label'
import { ClaudeAccountService } from './service'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-claude-display-name' } }))

function makeAccount(overrides: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id: 'account-1',
    email: 'me@example.com',
    managedAuthPath: '/tmp/auth-1',
    authMethod: 'subscription-oauth',
    organizationUuid: 'org-work',
    organizationName: 'Work',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

type ClaudeAccountSettingsSlice = {
  claudeManagedAccounts: ClaudeManagedAccount[]
  activeClaudeManagedAccountId: string | null
  activeClaudeManagedAccountIdsByRuntime: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

function createService(accounts: ClaudeManagedAccount[]) {
  let settings: ClaudeAccountSettingsSlice = {
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
  }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<ClaudeAccountSettingsSlice>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
  const service = new ClaudeAccountService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the displayName path only reads/writes claudeManagedAccounts on the store.
    store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateDisplayName does not call rate-limit methods.
    {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateDisplayName does not materialize runtime auth.
    {
      getRuntimeConfigDir: () => '/tmp/claude',
      router: {
        accountHome: () => '/tmp/missing-claude-home',
        userConfigDir: () => '/tmp/claude',
        systemDefaultHome: () => '/tmp/claude',
        copiedLoginIntoSystemDefault: () => false,
        coveredBySystemDefault: () => false
      }
    } as never
  )
  return { service, getSettings: () => settings }
}

describe('Claude managed account displayName persistence', () => {
  it('round-trips a custom name through the existing account store', async () => {
    const { service, getSettings } = createService([
      makeAccount(),
      makeAccount({
        id: 'account-2',
        managedAuthPath: '/tmp/auth-2',
        organizationUuid: 'org-personal',
        organizationName: 'Personal'
      })
    ])

    const listed = await service.updateDisplayName('account-1', '  Work org  ')
    const stored = getSettings().claudeManagedAccounts.find((account) => account.id === 'account-1')
    const summary = listed.accounts.find((account) => account.id === 'account-1')

    expect(stored?.displayName).toBe('Work org')
    expect(summary?.displayName).toBe('Work org')
    expect(JSON.parse(JSON.stringify(stored)).displayName).toBe('Work org')
    expect(
      service.listAccounts().accounts.find((account) => account.id === 'account-1')?.displayName
    ).toBe('Work org')
  })

  it('clears a blank name without changing the email identity', async () => {
    const { service, getSettings } = createService([makeAccount({ displayName: 'Work org' })])

    await service.updateDisplayName('account-1', '   ')
    expect(getSettings().claudeManagedAccounts[0]?.displayName).toBe(null)
    expect(getSettings().claudeManagedAccounts[0]?.email).toBe('me@example.com')
  })

  it('keeps same-email accounts distinguishable after persistence', async () => {
    const { service } = createService([
      makeAccount({ displayName: 'Work org' }),
      makeAccount({
        id: 'account-2',
        managedAuthPath: '/tmp/auth-2',
        organizationUuid: 'org-personal',
        organizationName: 'Personal'
      })
    ])

    const labels = service
      .listAccounts()
      .accounts.map((account) => getClaudeManagedAccountLabel(account))
    expect(new Set(labels).size).toBe(2)
  })
})
