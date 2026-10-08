import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import { ClaudeLaunchAccountError, resolveClaudeLaunchAccount } from './claude-launch-account'

function summary(
  id: string,
  email: string,
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

describe('resolveClaudeLaunchAccount', () => {
  const state = {
    accounts: [
      summary('acct-a', 'Alice@Example.com'),
      summary('acct-b', 'bob@example.com'),
      summary('acct-b2', 'bob@example.com'),
      summary('acct-wsl', 'wsl@example.com', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ],
    activeAccountId: 'acct-a'
  }

  it('resolves an exact id and reports whether it is the host account', () => {
    expect(resolveClaudeLaunchAccount(state, 'acct-a')).toEqual({
      accountId: 'acct-a',
      email: 'Alice@Example.com',
      isActiveOnHost: true
    })
    expect(resolveClaudeLaunchAccount(state, 'acct-b2').isActiveOnHost).toBe(false)
  })

  it('matches emails case-insensitively', () => {
    expect(resolveClaudeLaunchAccount(state, ' alice@example.COM ').accountId).toBe('acct-a')
  })

  it('lists the candidate ids when an email is ambiguous', () => {
    expect(() => resolveClaudeLaunchAccount(state, 'bob@example.com')).toThrow(
      /acct-b, acct-b2.*--account <id>/
    )
  })

  it('points unknown selectors at orca account list', () => {
    expect(() => resolveClaudeLaunchAccount(state, 'nobody@example.com')).toThrow(
      ClaudeLaunchAccountError
    )
    expect(() => resolveClaudeLaunchAccount(state, 'nobody@example.com')).toThrow(
      'orca account list'
    )
  })

  it('refuses WSL accounts and empty selectors', () => {
    expect(() => resolveClaudeLaunchAccount(state, 'acct-wsl')).toThrow(/host accounts only/)
    expect(() => resolveClaudeLaunchAccount(state, '  ')).toThrow(/requires a Claude account/)
  })
})
