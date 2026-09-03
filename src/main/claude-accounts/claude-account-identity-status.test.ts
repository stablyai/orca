import { describe, expect, it } from 'vitest'
import { compareClaudeAccountIdentity } from './claude-account-identity-status'

const account = {
  email: 'alice@example.com',
  organizationUuid: 'org-1',
  accountUuid: 'uuid-alice'
}

describe('compareClaudeAccountIdentity', () => {
  it('matches when the account UUID agrees', () => {
    expect(
      compareClaudeAccountIdentity({ accountUuid: 'uuid-alice', emailAddress: 'x@y.z' }, account)
    ).toBe('match')
  })

  it('reports foreign on a UUID mismatch even when the email matches', () => {
    // Ablation: turning the UUID branch into a fallback chain — falling through to the email when
    // the UUID disagrees — turns this green for a genuinely different account. A shared or stale
    // email must never soften a UUID mismatch.
    expect(
      compareClaudeAccountIdentity(
        { accountUuid: 'uuid-bob', emailAddress: 'alice@example.com' },
        account
      )
    ).toBe('foreign')
  })

  it('falls to the email only when a UUID is missing on either side', () => {
    expect(compareClaudeAccountIdentity({ emailAddress: 'alice@example.com' }, account)).toBe(
      'match'
    )
    expect(compareClaudeAccountIdentity({ emailAddress: 'bob@example.com' }, account)).toBe(
      'foreign'
    )
  })

  it('treats a conflicting organization as foreign even when the email matches', () => {
    expect(
      compareClaudeAccountIdentity(
        { emailAddress: 'alice@example.com', organizationUuid: 'org-2' },
        account
      )
    ).toBe('foreign')
  })

  it('normalizes case and surrounding whitespace before comparing', () => {
    expect(compareClaudeAccountIdentity({ emailAddress: '  ALICE@Example.com ' }, account)).toBe(
      'match'
    )
  })

  it.each([
    ['null', null],
    ['a non-object', 'not-an-object'],
    ['an array', []],
    ['an empty record', {}],
    ['a record with only blank fields', { accountUuid: '   ', emailAddress: '' }]
  ])('reports unknown for %s rather than guessing', (_label, oauthAccount) => {
    // Ablation: returning 'foreign' for any of these badges a healthy account as someone else's on
    // no evidence, and the user's only remedy is an unnecessary re-login.
    expect(compareClaudeAccountIdentity(oauthAccount, account)).toBe('unknown')
  })

  it('reports unknown when Orca has no stable field of its own to compare', () => {
    expect(
      compareClaudeAccountIdentity(
        { accountUuid: 'uuid-bob' },
        { email: '', organizationUuid: null }
      )
    ).toBe('unknown')
  })

  it('does not consult non-identity fields the CLI rewrites', () => {
    // The CLI rewrites cache/session fields in this record. Deep equality would call that foreign.
    expect(
      compareClaudeAccountIdentity(
        { accountUuid: 'uuid-alice', lastRefreshedAt: 123, cachedThing: { a: 1 } },
        account
      )
    ).toBe('match')
  })
})
