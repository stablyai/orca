import type { ClaudeManagedAccount } from '../../shared/types'
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
  // Why: accounts persisted before the runtime fields existed have
  // managedAuthRuntime === undefined; treat that as 'host' so a new host add
  // still matches them (#6616). WSL folds through the same distro-bucket key
  // runtime-selection.ts uses, so a distro compares equal to its own bucket.
  const normalizedRuntime = runtime ?? 'host'
  return normalizedRuntime === 'wsl' ? `wsl:${getClaudeWslSelectionKey(wslDistro)}` : 'host'
}

// Why: the same Claude email can legitimately belong to two organizations, and
// host vs WSL (and each WSL distro) keep separate managed-auth stores — so a
// duplicate is only a match on email + organization + runtime scope, each side
// normalized so a legacy/undefined field cannot dodge the check (#6616).
export function findDuplicateClaudeAccount(
  accounts: readonly ClaudeManagedAccount[],
  candidate: ClaudeAccountIdentityCandidate
): ClaudeManagedAccount | null {
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
