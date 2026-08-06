import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/types'
import {
  findDuplicateClaudeAccount,
  type ClaudeAccountIdentityCandidate
} from './claude-duplicate-account'

function makeAccount(overrides: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id: 'existing-account',
    email: 'host@x.com',
    managedAuthPath: '/managed/existing-account/auth',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function makeCandidate(
  overrides: Partial<ClaudeAccountIdentityCandidate> = {}
): ClaudeAccountIdentityCandidate {
  return {
    email: 'host@x.com',
    organizationUuid: null,
    managedAuthRuntime: 'host',
    wslDistro: null,
    ...overrides
  }
}

describe('findDuplicateClaudeAccount', () => {
  it('returns the existing account on an exact host match', () => {
    const account = makeAccount({ managedAuthRuntime: 'host', organizationUuid: null })
    expect(findDuplicateClaudeAccount([account], makeCandidate())?.id).toBe('existing-account')
  })

  it('returns null when the organization differs', () => {
    const account = makeAccount({ managedAuthRuntime: 'host', organizationUuid: 'org-A' })
    expect(
      findDuplicateClaudeAccount([account], makeCandidate({ organizationUuid: 'org-B' }))
    ).toBe(null)
  })

  it('returns null when a wsl candidate is compared against a host account', () => {
    const account = makeAccount({ managedAuthRuntime: 'host', organizationUuid: 'org-A' })
    expect(
      findDuplicateClaudeAccount(
        [account],
        makeCandidate({ organizationUuid: 'org-A', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
      )
    ).toBe(null)
  })

  it('returns null when both are wsl but on different distros', () => {
    const account = makeAccount({
      managedAuthRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      organizationUuid: 'org-A'
    })
    expect(
      findDuplicateClaudeAccount(
        [account],
        makeCandidate({ organizationUuid: 'org-A', managedAuthRuntime: 'wsl', wslDistro: 'Debian' })
      )
    ).toBe(null)
  })

  it('returns the account when both are wsl on the same distro', () => {
    const account = makeAccount({
      managedAuthRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      organizationUuid: 'org-A'
    })
    expect(
      findDuplicateClaudeAccount(
        [account],
        makeCandidate({ organizationUuid: 'org-A', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
      )?.id
    ).toBe('existing-account')
  })

  it('matches a legacy account with undefined runtime against a host candidate', () => {
    // managedAuthRuntime omitted → undefined normalizes to 'host'.
    const account = makeAccount({ organizationUuid: null })
    expect(findDuplicateClaudeAccount([account], makeCandidate())?.id).toBe('existing-account')
  })

  it('treats an existing undefined org as equal to a candidate null org', () => {
    // organizationUuid omitted → undefined, candidate is explicit null.
    const account = makeAccount({ managedAuthRuntime: 'host' })
    expect(
      findDuplicateClaudeAccount([account], makeCandidate({ organizationUuid: null }))?.id
    ).toBe('existing-account')
  })

  it('matches when the email differs only by case and whitespace', () => {
    const account = makeAccount({ managedAuthRuntime: 'host', email: 'Host@X.com ' })
    expect(findDuplicateClaudeAccount([account], makeCandidate({ email: 'host@x.com' }))?.id).toBe(
      'existing-account'
    )
  })

  it('returns null when the candidate email is null', () => {
    const account = makeAccount({ managedAuthRuntime: 'host' })
    expect(findDuplicateClaudeAccount([account], makeCandidate({ email: null }))).toBe(null)
  })

  it('returns null for an empty accounts array', () => {
    expect(findDuplicateClaudeAccount([], makeCandidate())).toBe(null)
  })
})
