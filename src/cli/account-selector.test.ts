import { describe, expect, it } from 'vitest'

import { resolveClaudeAccountId } from './account-selector'

const snapshot = {
  accounts: [
    {
      id: 'personal',
      email: 'me@example.com',
      authMethod: 'subscription-oauth' as const,
      managedAuthRuntime: 'host' as const,
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    },
    {
      id: 'work',
      email: 'work@example.com',
      authMethod: 'subscription-oauth' as const,
      managedAuthRuntime: 'wsl' as const,
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
  ],
  activeAccountId: 'personal'
}

describe('resolveClaudeAccountId', () => {
  it('prefers exact ids and resolves exact emails case-insensitively', () => {
    expect(resolveClaudeAccountId(snapshot, 'work')).toBe('work')
    expect(resolveClaudeAccountId(snapshot, 'WORK@EXAMPLE.COM')).toBe('work')
  })

  it('returns null for the explicit system-default selector', () => {
    expect(resolveClaudeAccountId(snapshot, null)).toBeNull()
  })

  it('rejects unknown selectors', () => {
    expect(() => resolveClaudeAccountId(snapshot, 'missing')).toThrow(/orca account list/)
  })

  it('rejects ambiguous email selectors', () => {
    const ambiguous = {
      ...snapshot,
      accounts: [
        snapshot.accounts[0],
        { ...snapshot.accounts[1], email: snapshot.accounts[0].email }
      ]
    }
    expect(() => resolveClaudeAccountId(ambiguous, 'ME@EXAMPLE.COM')).toThrow(/multiple accounts/)
  })
})
