import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import { getClaudeWslSelectionKey } from './runtime-selection'

export type ClaudeAccountIdentityCandidate = {
  email: string | null
  organizationUuid: string | null
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
}

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

function normalizeOrganizationUuid(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function runtimeScopeKey(
  runtime: 'host' | 'wsl' | undefined,
  wslDistro: string | null | undefined
): string {
  // Legacy accounts without a runtime field belong to the host.
  const normalizedRuntime = runtime ?? 'host'
  return normalizedRuntime === 'wsl' ? `wsl:${getClaudeWslSelectionKey(wslDistro)}` : 'host'
}

// Organizations and runtime scopes have separate accounts even when emails match.
export function findDuplicateClaudeAccount(
  accounts: readonly ClaudeManagedAccountSummary[],
  candidate: ClaudeAccountIdentityCandidate
): ClaudeManagedAccountSummary | null {
  const email = normalizeEmail(candidate.email)
  if (!email) {
    return null
  }
  const organizationUuid = normalizeOrganizationUuid(candidate.organizationUuid)
  const scope = runtimeScopeKey(candidate.managedAuthRuntime, candidate.wslDistro)
  return (
    accounts.find(
      (account) =>
        normalizeEmail(account.email) === email &&
        normalizeOrganizationUuid(account.organizationUuid) === organizationUuid &&
        runtimeScopeKey(account.managedAuthRuntime, account.wslDistro) === scope
    ) ?? null
  )
}
