import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeSystemDefaultIdentity
} from '../../shared/managed-account-types'
import { findDuplicateClaudeAccount, normalizeClaudeEmail } from './claude-duplicate-account'
import type { ClaudeLoginIdentity, ClaudeLoginState } from './claude-profile-readiness'
import { getClaudeProfileSetupIssue } from './claude-profile-setup-issues'
import { isUnfinishedClaudeSignIn } from '../../shared/claude-unfinished-sign-in'
import { describeClaudeAccountIdentityRefusal } from '../../shared/claude-account-refusal-copy'

export type ClaudeObservedAccount = Pick<
  ClaudeManagedAccount,
  | 'id'
  | 'email'
  | 'organizationUuid'
  | 'managedAuthRuntime'
  | 'wslDistro'
  | 'createdAt'
  | 'lastAuthenticatedAt'
> & { observed: { email: string; organizationUuid: string | null } | null }

export type ClaudeAccountIdentityIssue = 'mismatch' | 'duplicate'

/**
 * Compares each row's stored identity with the login its profile actually holds. Exactly one row
 * per login stays clean: a row whose profile matches its label outranks one that does not, a
 * signed-in row outranks an unfinished one, then the row added first wins, so signing in again
 * never moves the flag onto the original row.
 */
export function findClaudeAccountIdentityIssues(
  accounts: readonly ClaudeObservedAccount[]
): Map<string, ClaudeAccountIdentityIssue> {
  const consistent = (account: ClaudeObservedAccount) =>
    !account.observed ||
    isUnfinishedClaudeSignIn(account) ||
    (normalizeClaudeEmail(account.observed.email) === normalizeClaudeEmail(account.email) &&
      (!account.organizationUuid ||
        !account.observed.organizationUuid ||
        account.organizationUuid === account.observed.organizationUuid))
  const rank = (account: ClaudeObservedAccount) => [
    consistent(account) ? 0 : 1,
    isUnfinishedClaudeSignIn(account) ? 1 : 0,
    account.createdAt,
    account.lastAuthenticatedAt
  ]
  const outranks = (left: ClaudeObservedAccount, right: ClaudeObservedAccount) => {
    const [a, b] = [rank(left), rank(right)]
    const differs = a.findIndex((value, index) => value !== b[index])
    return differs === -1 ? left.id < right.id : a[differs] < b[differs]
  }
  const effective = (account: ClaudeObservedAccount) => ({
    email: account.observed?.email ?? account.email,
    organizationUuid: account.observed
      ? account.observed.organizationUuid
      : (account.organizationUuid ?? null),
    managedAuthRuntime: account.managedAuthRuntime ?? 'host',
    wslDistro: account.wslDistro ?? null
  })
  const issues = new Map<string, ClaudeAccountIdentityIssue>()
  for (const account of accounts) {
    const others = accounts
      .filter((entry) => entry.id !== account.id && outranks(entry, account))
      .map(effective)
    if (findDuplicateClaudeAccount(others, effective(account))) {
      issues.set(account.id, 'duplicate')
    } else if (!consistent(account)) {
      issues.set(account.id, 'mismatch')
    }
  }
  return issues
}

/** Why launching or selecting an account is refused for the login its profile holds. */
export function findClaudeAccountIdentityRefusal(
  accounts: readonly Omit<ClaudeObservedAccount, 'observed'>[],
  accountId: string,
  owner: { profileState: (accountId: string) => ClaudeLoginState }
): string | null {
  const observedIdentity = (id: string) => {
    const state = owner.profileState(id)
    return state.readiness === 'ready' ? state.identity : null
  }
  const account = accounts.find((entry) => entry.id === accountId)
  const identity = account ? observedIdentity(accountId) : null
  if (!account || !identity) {
    return null
  }
  const observed = accounts.map((entry) => ({
    ...entry,
    observed: entry.id === accountId ? identity : observedIdentity(entry.id)
  }))
  const issue = findClaudeAccountIdentityIssues(observed).get(accountId)
  return issue
    ? describeClaudeAccountIdentityRefusal(issue, {
        addedAs: account.email,
        signedInAs: identity.email
      })
    : null
}

/** Adds each row's readiness and the login its profile holds; derived on every read. */
export function withObservedClaudeIdentities(
  accounts: readonly ClaudeManagedAccountSummary[],
  owner: { profileState: (accountId: string) => ClaudeLoginState }
): ClaudeManagedAccountSummary[] {
  const observed = accounts.map((account) => {
    const state = owner.profileState(account.id)
    const identity = state.readiness === 'ready' ? state.identity : null
    return { ...account, profileReadiness: state.readiness, observed: identity }
  })
  const issues = findClaudeAccountIdentityIssues(observed)
  return observed.map(({ observed: identity, ...account }) => {
    const profileIdentityIssue = issues.get(account.id)
    const profileSetupIssue = getClaudeProfileSetupIssue(account.id)
    return {
      ...account,
      ...(profileSetupIssue ? { profileSetupIssue } : {}),
      ...(identity ? { profileEmail: identity.email } : {}),
      ...(profileIdentityIssue ? { profileIdentityIssue } : {})
    }
  })
}

/** Only with a finished account: the personal state file is large, and the notice needs one. */
export function describeClaudeSystemDefaultFor(
  owner: { systemDefaultIdentity?: () => ClaudeLoginIdentity | null },
  accounts: readonly ClaudeManagedAccountSummary[]
): { systemDefault?: ClaudeSystemDefaultIdentity } {
  return owner.systemDefaultIdentity && !accounts.every(isUnfinishedClaudeSignIn)
    ? { systemDefault: describeClaudeSystemDefault(owner.systemDefaultIdentity(), accounts) }
    : {}
}

/** System Default's login, flagged when it is also a saved account (an earlier Orca copied those). */
export function describeClaudeSystemDefault(
  identity: ClaudeLoginIdentity | null,
  accounts: readonly Pick<ClaudeManagedAccountSummary, 'email' | 'profileEmail'>[]
): ClaudeSystemDefaultIdentity {
  const email = normalizeClaudeEmail(identity?.email)
  return {
    email: identity?.email ?? null,
    matchesSavedAccount:
      email !== null &&
      accounts.some(
        (account) =>
          normalizeClaudeEmail(account.email) === email ||
          normalizeClaudeEmail(account.profileEmail) === email
      )
  }
}
