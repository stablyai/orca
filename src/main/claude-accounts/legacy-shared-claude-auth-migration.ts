import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveOwnedClaudeManagedAuthPath } from './managed-auth-path'

export const LEGACY_SHARED_CLAUDE_AUTH_MIGRATION_MARKER =
  'per-account-claude-auth-migration-v1.json'

export type ClaudeAuthMigrationOutcome =
  | 'migrated'
  | 'already-present'
  | 'no-shared-auth'
  | 'ambiguous'
  | 'unavailable'

type MigrationOptions = {
  accounts: ClaudeManagedAccount[]
  activeAccountId?: string | null
  sharedAuthPath: string
  metadataDir: string
  readLegacyKeychain?: () => Promise<string | null>
  readLegacyOauthAccount?: () => unknown
  readManagedCredentials: (account: ClaudeManagedAccount) => Promise<string | null>
  writeManagedCredentials: (account: ClaudeManagedAccount, contents: string) => Promise<void>
}

/** One-way migration for pre-isolation shared Claude credentials. */
export async function migrateLegacySharedClaudeAuth(
  options: MigrationOptions
): Promise<ClaudeAuthMigrationOutcome> {
  const markerPath = join(options.metadataDir, LEGACY_SHARED_CLAUDE_AUTH_MIGRATION_MARKER)
  try {
    if (statSync(markerPath).isFile()) {
      return 'already-present'
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      return 'unavailable'
    }
  }

  // Prove the active destination before touching the shared credential store.
  // An untrusted path must never cause reads of (or writes to) real credentials.
  if (options.activeAccountId) {
    const activeAccount = options.accounts.find(({ id }) => id === options.activeAccountId)
    if (
      !activeAccount ||
      !resolveOwnedClaudeManagedAuthPath(activeAccount.id, activeAccount.managedAuthPath)
    ) {
      return 'unavailable'
    }
  }
  let shared: string | null = null
  try {
    shared = options.readLegacyKeychain
      ? await options.readLegacyKeychain()
      : readFileSync(options.sharedAuthPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return stamp(markerPath, 'no-shared-auth')
    }
    return 'unavailable'
  }
  if (!shared) {
    return stamp(markerPath, 'no-shared-auth')
  }

  const identity = await parseIdentity(shared, options.readLegacyOauthAccount)
  if (!identity) {
    return 'unavailable'
  }
  const candidates = options.accounts.filter((account) => {
    const emailMatch = identity.email && account.email.trim().toLowerCase() === identity.email
    const orgMatch = identity.organizationUuid
      ? account.organizationUuid === identity.organizationUuid
      : true
    return Boolean(emailMatch && orgMatch)
  })
  if (candidates.length !== 1) {
    return 'ambiguous'
  }
  const account = candidates[0]
  if (options.activeAccountId && account.id !== options.activeAccountId) {
    return 'ambiguous'
  }
  if (!resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath)) {
    return 'unavailable'
  }
  const existing = await options.readManagedCredentials(account)
  if (!existing) {
    try {
      await options.writeManagedCredentials(account, shared)
    } catch {
      return 'unavailable'
    }
  }
  return stamp(markerPath, existing ? 'already-present' : 'migrated', account.id)
}

async function parseIdentity(
  contents: string,
  readOauthAccount?: () => unknown
): Promise<{ email: string | null; organizationUuid: string | null } | null> {
  try {
    const root = JSON.parse(contents) as Record<string, unknown>
    const oauth = root.claudeAiOauth
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
      return null
    }
    const value = oauth as Record<string, unknown>
    const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : null
    const organizationUuid =
      typeof value.organizationUuid === 'string' ? value.organizationUuid.trim() : null
    if (email) {
      return { email, organizationUuid }
    }
    const runtime = readOauthAccount ? await readOauthAccount() : null
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      return null
    }
    const runtimeValue = runtime as Record<string, unknown>
    const runtimeEmail =
      typeof runtimeValue.emailAddress === 'string'
        ? runtimeValue.emailAddress.trim().toLowerCase()
        : typeof runtimeValue.email === 'string'
          ? runtimeValue.email.trim().toLowerCase()
          : null
    const runtimeOrg =
      typeof runtimeValue.organizationUuid === 'string'
        ? runtimeValue.organizationUuid.trim()
        : typeof runtimeValue.organizationId === 'string'
          ? runtimeValue.organizationId.trim()
          : null
    return runtimeEmail ? { email: runtimeEmail, organizationUuid: runtimeOrg } : null
  } catch {
    return null
  }
}

function stamp(path: string, outcome: string, accountId?: string): ClaudeAuthMigrationOutcome {
  try {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileAtomically(
      path,
      `${JSON.stringify({ version: 1, completedAt: Date.now(), outcome, accountId: accountId ?? null })}\n`,
      { mode: 0o600 }
    )
    return outcome as ClaudeAuthMigrationOutcome
  } catch {
    return 'unavailable'
  }
}
