import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

/**
 * Whether the account's own home is signed in as the identity Orca recorded for it.
 *
 * `unknown` is not a soft `foreign`. An unreadable or torn identity record, or one that exposes no
 * stable field, tells us nothing — and badging an account as someone else's on no evidence is worse
 * than saying nothing, because the user's only remedy is to sign in again.
 */
export type ClaudeAccountIdentityStatus = 'match' | 'foreign' | 'unknown'

function normalized(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function normalizedEmail(value: unknown): string | null {
  return normalized(value)?.toLowerCase() ?? null
}

type OauthAccountIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}

/** The CLI writes this record; treat every field as absent until proven otherwise. */
export function readClaudeOauthAccountIdentity(oauthAccount: unknown): OauthAccountIdentity {
  if (!oauthAccount || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
    return { accountUuid: null, email: null, organizationUuid: null }
  }
  const record = oauthAccount as Record<string, unknown>
  return {
    accountUuid: normalized(record.accountUuid) ?? normalized(record.accountId),
    email: normalizedEmail(record.emailAddress) ?? normalizedEmail(record.email),
    organizationUuid: normalized(record.organizationUuid) ?? normalized(record.organizationId)
  }
}

/**
 * Compares the home's identity record against the account Orca thinks it is.
 *
 * **Precedence is strict, not a fallback chain.** When both sides expose the account UUID, that
 * comparison decides on its own and the weaker fields are never consulted. Falling through to email
 * after a UUID mismatch would let a shared or stale email mask a genuinely different account — the
 * softening this check exists to prevent. Only when the stronger field is missing on either side do
 * we fall to the next one.
 *
 * Never deep-equals the records: the CLI rewrites cache and non-identity fields in this file, and
 * treating that as a mismatch would badge a healthy account as foreign.
 */
export function compareClaudeAccountIdentity(
  oauthAccount: unknown,
  account: Pick<ClaudeManagedAccount, 'email' | 'organizationUuid'> & {
    accountUuid?: string | null
  }
): ClaudeAccountIdentityStatus {
  const home = readClaudeOauthAccountIdentity(oauthAccount)

  const expectedUuid = normalized(account.accountUuid)
  if (home.accountUuid !== null && expectedUuid !== null) {
    return home.accountUuid === expectedUuid ? 'match' : 'foreign'
  }

  const expectedEmail = normalizedEmail(account.email)
  if (home.email !== null && expectedEmail !== null) {
    if (home.email !== expectedEmail) {
      return 'foreign'
    }
    // A matching email is only provisional evidence: two accounts in different organizations can
    // share one. A conflicting org on top of a matching email is still a different account.
    const expectedOrg = normalized(account.organizationUuid)
    if (home.organizationUuid !== null && expectedOrg !== null) {
      return home.organizationUuid === expectedOrg ? 'match' : 'foreign'
    }
    return 'match'
  }

  return 'unknown'
}
