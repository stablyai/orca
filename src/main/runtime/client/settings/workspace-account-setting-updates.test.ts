import type { ClaudeManagedAccount } from '../../../../shared/agent-accounts/managed-account-types'
import { expect, it } from 'vitest'
import { workspaceAccountSettingUpdates } from './workspace-account-setting-updates'

it('assigns a Claude account atomically and keeps its history private after clearing the assignment', () => {
  const account = (id: string): ClaudeManagedAccount => ({
    id,
    email: `${id}@example.test`,
    managedAuthPath: '/unused',
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  })
  const settings = {
    claudeManagedAccounts: [account('personal'), account('work')],
    claudeWorkspaceAccounts: { 'folder:other': 'personal' },
    codexWorkspaceAccounts: { 'folder:client': 'codex-work' }
  }
  const assigned = workspaceAccountSettingUpdates(settings, {
    claudeWorkspaceAccount: { workspaceId: 'worktree:project::/client', accountId: 'work' }
  })
  expect(assigned.claudeWorkspaceAccounts).toEqual({
    'folder:other': 'personal',
    'project::/client': 'work'
  })
  expect(assigned.claudeManagedAccounts?.find((entry) => entry.id === 'work')?.privateHistory).toBe(
    true
  )
  expect(
    assigned.claudeManagedAccounts?.find((entry) => entry.id === 'personal')?.privateHistory
  ).toBe(true)
  const cleared = {
    ...settings,
    ...assigned,
    ...workspaceAccountSettingUpdates(
      { ...settings, ...assigned },
      { claudeWorkspaceAccount: { workspaceId: 'project::/client', accountId: null } }
    )
  }
  expect(cleared.claudeWorkspaceAccounts).toEqual({ 'folder:other': 'personal' })
  expect(cleared.claudeManagedAccounts.find((entry) => entry.id === 'work')?.privateHistory).toBe(
    true
  )
  expect(cleared.codexWorkspaceAccounts).toEqual({ 'folder:client': 'codex-work' })
})
