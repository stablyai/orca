import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeCredentialReadResult } from './claude-credential-read-result'

export const PER_ACCOUNT_CLAUDE_STORE_MIGRATION_MARKER =
  'per-account-claude-store-migration-v1.json'

export type ClaudeStoreMigrationOutcome =
  /** The id-keyed value was copied into the store the CLI owns. */
  | 'migrated'
  /** The CLI already has a credential here; we never overwrite one. */
  | 'already-present'
  | 'no-source'
  | 'unavailable'
  /** Not an isolated macOS account, so it has no scoped store to migrate into. */
  | 'out-of-lane'

type MigrationOptions = {
  accounts: readonly ClaudeManagedAccount[]
  metadataDir: string
  /** Orca's pre-change account-id-keyed service. Read only — never deleted. */
  readIdKeyedCredentials: (accountId: string) => Promise<string | null>
  /** The composed CLI-owned destination: scoped Keychain item plus same-home file. */
  readDestination: (account: ClaudeManagedAccount) => Promise<ClaudeCredentialReadResult>
  writeDestination: (account: ClaudeManagedAccount, credentialsJson: string) => Promise<void>
}

type MarkerFile = { completedAccountIds?: unknown }

function readCompletedAccountIds(markerPath: string): Set<string> | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as MarkerFile
    return new Set(
      Array.isArray(parsed.completedAccountIds)
        ? parsed.completedAccountIds.filter((id): id is string => typeof id === 'string')
        : []
    )
  } catch (error) {
    // A marker we cannot read is not an empty marker: re-running migration against an unknown
    // state risks copying over a credential we already migrated past.
    return isDefinitiveAbsence(error) ? new Set() : null
  }
}

/**
 * Moves pre-change accounts off Orca's private account-id-keyed Keychain service and onto the
 * store the Claude CLI itself owns.
 *
 * Two rules carry the safety of this operation:
 *
 * 1. **The source is never deleted.** A read-back proves the destination holds what we copied; it
 *    does not prove the source was unchanged meanwhile. Deleting on that evidence can erase a
 *    rotation we never copied. The leftover item is inert once nothing reads it, and removing the
 *    account removes it.
 * 2. **A destination that already holds anything wins.** The CLI's store is Keychain *plus* the
 *    same-home file; a value in either means the CLI owns this account and our copy is stale. This
 *    is checked immediately before the write, not once at the top.
 */
export async function migrateClaudeAccountsToScopedStore(
  options: MigrationOptions
): Promise<Map<string, ClaudeStoreMigrationOutcome>> {
  const outcomes = new Map<string, ClaudeStoreMigrationOutcome>()
  const markerPath = join(options.metadataDir, PER_ACCOUNT_CLAUDE_STORE_MIGRATION_MARKER)
  const completed = readCompletedAccountIds(markerPath)
  if (completed === null) {
    for (const account of options.accounts) {
      outcomes.set(account.id, 'unavailable')
    }
    return outcomes
  }

  let changed = false
  for (const account of options.accounts) {
    if (completed.has(account.id)) {
      continue
    }
    // Only an isolated macOS account has a config-dir-scoped store to own its credential.
    if (account.managedAuthRuntime !== 'host' || process.platform !== 'darwin') {
      outcomes.set(account.id, 'out-of-lane')
      continue
    }
    const outcome = await migrateOneAccount(account, options)
    outcomes.set(account.id, outcome)
    // A failure is retried on the next start rather than recorded as done.
    if (outcome !== 'unavailable') {
      completed.add(account.id)
      changed = true
    }
  }

  if (changed) {
    try {
      mkdirSync(options.metadataDir, { recursive: true })
      writeFileAtomically(
        markerPath,
        JSON.stringify({ completedAccountIds: [...completed] }, null, 2)
      )
    } catch {
      // Fail open: a marker we could not persist only costs a redundant, idempotent re-run.
    }
  }
  return outcomes
}

async function migrateOneAccount(
  account: ClaudeManagedAccount,
  options: MigrationOptions
): Promise<ClaudeStoreMigrationOutcome> {
  let source: string | null
  try {
    source = await options.readIdKeyedCredentials(account.id)
  } catch {
    return 'unavailable'
  }
  if (source === null || source.trim() === '') {
    return 'no-source'
  }

  // Re-read here, immediately before the write, rather than once at the top: the CLI can create
  // this item at any moment and a blind write would clobber a rotation with our older copy.
  let destination: ClaudeCredentialReadResult
  try {
    destination = await options.readDestination(account)
  } catch {
    return 'unavailable'
  }
  if (destination.kind === 'unavailable') {
    return 'unavailable'
  }
  if (destination.kind === 'present') {
    return 'already-present'
  }

  try {
    await options.writeDestination(account, source)
  } catch {
    return 'unavailable'
  }
  return 'migrated'
}
