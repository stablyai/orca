import type { ClaudeManagedAccountSummary } from '../../../shared/agent-accounts/managed-account-types'
import { claudeAccountIdentityKey } from '../../../shared/claude-account-identity'

export type ClaudeAccountIdentityCandidate = {
  email: string | null
  organizationUuid: string | null
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
}

// Organizations and runtime scopes have separate accounts even when emails match.
export function findDuplicateClaudeAccount(
  accounts: readonly ClaudeManagedAccountSummary[],
  candidate: ClaudeAccountIdentityCandidate
): ClaudeManagedAccountSummary | null {
  const key = claudeAccountIdentityKey(candidate)
  return key
    ? (accounts.find((account) => claudeAccountIdentityKey(account) === key) ?? null)
    : null
}
