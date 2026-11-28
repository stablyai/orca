import { describe, expect, it, vi } from 'vitest'
import { resolveWorktreeStartupClaudeAccount } from './runtime-worktree-startup-claude-account'

const accounts = {
  accounts: [
    {
      id: 'acct-b',
      email: 'pinned@example.com',
      managedAuthRuntime: 'host' as const,
      wslDistro: null,
      authMethod: 'subscription-oauth' as const,
      organizationUuid: null,
      organizationName: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ],
  activeAccountId: null
}

function resolve(overrides: Partial<Parameters<typeof resolveWorktreeStartupClaudeAccount>[0]>) {
  return resolveWorktreeStartupClaudeAccount({
    request: { startupAgent: 'claude', startupClaudeAccount: 'pinned@example.com' },
    createRouteKind: 'local',
    canSpawn: true,
    listClaudeAccounts: () => accounts,
    ...overrides
  })
}

describe('resolveWorktreeStartupClaudeAccount', () => {
  it('resolves the selector for a local Claude startup agent', () => {
    expect(resolve({})).toBe('acct-b')
  })

  it('is a no-op without --account and never lists accounts', () => {
    const listClaudeAccounts = vi.fn(() => accounts)
    expect(
      resolve({ request: { startupAgent: 'claude' }, createRouteKind: 'ssh', listClaudeAccounts })
    ).toBeUndefined()
    expect(listClaudeAccounts).not.toHaveBeenCalled()
  })

  it('refuses every case the startup terminal could not honour', () => {
    expect(() =>
      resolve({ request: { startupAgent: 'codex', startupClaudeAccount: 'acct-b' } })
    ).toThrow('--account requires --agent claude.')
    expect(() => resolve({ createRouteKind: 'ssh' })).toThrow(/not supported for SSH/)
    expect(() => resolve({ createRouteKind: 'runtime' })).toThrow(/connected-server/)
    expect(() => resolve({ canSpawn: false })).toThrow(/cannot start Claude --account/)
    expect(() =>
      resolve({ request: { startupAgent: 'claude', startupClaudeAccount: 'nobody@example.com' } })
    ).toThrow(/orca account list/)
  })
})
