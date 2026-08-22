import { describe, expect, it } from 'vitest'
import {
  decideMonotonicCredentialWrite,
  pickFreshestCredentialsJson,
  readCredentialExpiresAt
} from './credential-freshness'

function credentials(input: {
  email?: string
  accountUuid?: string
  organizationUuid?: string
  accessToken?: string
  expiresAt?: number | string | null
  omitExpiresAt?: boolean
}): string {
  const oauth: Record<string, unknown> = {
    accessToken: input.accessToken ?? 'token',
    refreshToken: `${input.accessToken ?? 'token'}-refresh`
  }
  if (input.email !== undefined) {
    oauth.email = input.email
  }
  if (input.accountUuid !== undefined) {
    oauth.accountUuid = input.accountUuid
  }
  if (input.organizationUuid !== undefined) {
    oauth.organizationUuid = input.organizationUuid
  }
  if (!input.omitExpiresAt) {
    oauth.expiresAt = input.expiresAt === undefined ? 2_000 : input.expiresAt
  }
  return JSON.stringify({ claudeAiOauth: oauth })
}

describe('credential-freshness', () => {
  it('normalizes numeric and numeric-string seconds while rejecting non-numeric expiry', () => {
    expect(readCredentialExpiresAt(credentials({ expiresAt: 5_000 }))).toBe(5_000_000)
    expect(
      readCredentialExpiresAt(
        JSON.stringify({ claudeAiOauth: { accessToken: 't', expires_at: 7_000 } })
      )
    ).toBe(7_000_000)
    expect(readCredentialExpiresAt(credentials({ expiresAt: '7000' }))).toBe(7_000_000)
    expect(readCredentialExpiresAt('not-json')).toBeNull()
    expect(readCredentialExpiresAt(credentials({ expiresAt: 'bad' }))).toBeNull()
  })

  it('orders mixed epoch seconds and milliseconds after normalization', () => {
    const seconds = credentials({ accessToken: 'seconds', expiresAt: '9000000000' })
    const milliseconds = credentials({ accessToken: 'milliseconds', expiresAt: 8_000_000_000_000 })

    expect(
      decideMonotonicCredentialWrite({ candidateJson: seconds, existingJson: milliseconds })
    ).toBe('write')
  })

  it('writes when there is no existing credential', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ email: 'a@example.com', expiresAt: 1_000 }),
        existingJson: null
      })
    ).toBe('write')
  })

  it('keeps existing when candidate is strictly older for the same identity', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'old',
          expiresAt: 1_000
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'new', expiresAt: 9_000 })
      })
    ).toBe('keep-existing')
  })

  it('writes when candidate is strictly newer for the same identity', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'new',
          expiresAt: 9_000
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'old', expiresAt: 1_000 })
      })
    ).toBe('write')
  })

  it('keeps equal-expiry lineages unless the caller knows the candidate direction', () => {
    const candidateJson = credentials({
      email: 'a@example.com',
      accessToken: 'a',
      expiresAt: 5_000
    })
    const existingJson = credentials({
      email: 'a@example.com',
      accessToken: 'b',
      expiresAt: 5_000
    })
    expect(
      decideMonotonicCredentialWrite({
        candidateJson,
        existingJson
      })
    ).toBe('keep-existing')
    expect(
      decideMonotonicCredentialWrite({ candidateJson, existingJson, equalExpiry: 'write' })
    ).toBe('write')
  })

  it('keeps existing dated credential when candidate expiresAt is missing or invalid', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'missing',
          omitExpiresAt: true
        }),
        existingJson: credentials({
          email: 'a@example.com',
          accessToken: 'dated',
          expiresAt: 9_000
        })
      })
    ).toBe('keep-existing')
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'bad',
          expiresAt: 'not-a-number'
        }),
        existingJson: credentials({
          email: 'a@example.com',
          accessToken: 'dated',
          expiresAt: 9_000
        })
      })
    ).toBe('keep-existing')
  })

  it('keeps existing when neither lineage has a trustworthy expiry', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ accessToken: 'candidate', omitExpiresAt: true }),
        existingJson: credentials({ accessToken: 'existing', omitExpiresAt: true })
      })
    ).toBe('keep-existing')
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ accessToken: 'candidate', expiresAt: 'bad' }),
        existingJson: credentials({ accessToken: 'existing', expiresAt: 'also-bad' })
      })
    ).toBe('keep-existing')
  })

  it('keeps an unknown-expiry existing credential unless candidate direction is trusted', () => {
    const candidateJson = credentials({
      email: 'a@example.com',
      accessToken: 'dated',
      expiresAt: 1_000
    })
    const missingExpiryJson = credentials({
      email: 'a@example.com',
      accessToken: 'missing',
      omitExpiresAt: true
    })
    const stringExpiryJson = credentials({
      email: 'a@example.com',
      accessToken: 'string-expiry',
      expiresAt: '9999999999999'
    })

    expect(
      decideMonotonicCredentialWrite({
        candidateJson,
        existingJson: missingExpiryJson
      })
    ).toBe('keep-existing')
    expect(decideMonotonicCredentialWrite({ candidateJson, existingJson: stringExpiryJson })).toBe(
      'keep-existing'
    )
    expect(
      decideMonotonicCredentialWrite({
        candidateJson,
        existingJson: missingExpiryJson,
        unknownExistingExpiry: 'write'
      })
    ).toBe('write')
  })

  it('does not reject a credential object solely because OAuth accessToken is absent', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: JSON.stringify({
          claudeAiOauth: { email: 'a@example.com', expiresAt: 9_000 }
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'ok', expiresAt: 1_000 })
      })
    ).toBe('write')
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: JSON.stringify({ apiKey: 'synthetic-new' }),
        existingJson: JSON.stringify({ apiKey: 'synthetic-old' }),
        unknownExistingExpiry: 'write'
      })
    ).toBe('write')
  })

  it('picks the freshest credential among diverged stores', () => {
    const stale = credentials({ email: 'a@example.com', accessToken: 'stale', expiresAt: 1_000 })
    const mid = credentials({ email: 'a@example.com', accessToken: 'mid', expiresAt: 2_000 })
    const fresh = credentials({ email: 'a@example.com', accessToken: 'fresh', expiresAt: 3_000 })
    expect(pickFreshestCredentialsJson([stale, null, fresh, mid, 'not-json'])).toBe(fresh)
    expect(pickFreshestCredentialsJson([null, undefined, ''])).toBeNull()
  })

  it('uses numeric-string expiry when choosing among stores', () => {
    const numericString = credentials({ accessToken: 'numeric-string', expiresAt: '9999999999999' })
    const finite = credentials({ accessToken: 'finite', expiresAt: 1_000 })

    expect(pickFreshestCredentialsJson([numericString, finite])).toBe(numericString)
    expect(pickFreshestCredentialsJson([finite, numericString])).toBe(numericString)
  })

  it('does not trust absurd far-future expiry values', () => {
    expect(readCredentialExpiresAt(credentials({ expiresAt: 9_000_000_000_000_000 }))).toBeNull()
  })
})
