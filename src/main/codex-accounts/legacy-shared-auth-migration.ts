import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/types'
import { writeFileAtomically } from './fs-utils'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'
import { codexAuthMatchesManagedAccount, compareCodexAuthFreshness } from './codex-auth-identity'

export const LEGACY_SHARED_AUTH_MIGRATION_MARKER = 'per-account-auth-migration-v1.json'
// Why: the auth and MCP carries are independent generations. A build that ran
// only the auth migration already stamped the v1 marker, so gating the MCP
// carry (#8440) on that same marker would strand .credentials.json forever.
export const LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER =
  'per-account-mcp-creds-migration-v1.json'

type LegacySharedAuthMigrationOptions = {
  activeHostAccountId: string | null
  hostAccounts: readonly CodexManagedAccount[]
  managedAccountsRoot: string
  metadataDir: string
  sharedRuntimeHome: string
  systemCodexHome: string
}

type TrustedAccountAuth = {
  account: CodexManagedAccount
  authContents: string | null
  authPath: string | null
  homePath: string | null
}

type CompletedOutcome =
  | 'already-current'
  | 'migrated'
  | 'no-shared-auth'
  | 'no-shared-credentials'
  | 'not-newer'
  | 'per-account-present'

export function migrateLegacySharedAuthToPerAccountHome({
  activeHostAccountId,
  hostAccounts,
  managedAccountsRoot,
  metadataDir,
  sharedRuntimeHome,
  systemCodexHome
}: LegacySharedAuthMigrationOptions): void {
  if (!activeHostAccountId || !hostAccounts.some(({ id }) => id === activeHostAccountId)) {
    return
  }
  const authMarkerPath = join(metadataDir, LEGACY_SHARED_AUTH_MIGRATION_MARKER)
  const mcpMarkerPath = join(metadataDir, LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER)
  const authDone = regularFileState(authMarkerPath) === 'present'
  const mcpDone = regularFileState(mcpMarkerPath) === 'present'
  if (authDone && mcpDone) {
    return
  }

  const sharedAuthContents = readRegularFile(join(sharedRuntimeHome, 'auth.json'))
  if (sharedAuthContents === null) {
    // Why: MCP tokens carry no identity claim of their own; without a shared
    // auth.json there is no ownership proof, so both lanes conclude.
    if (!authDone) {
      writeCompletedMarker(authMarkerPath, 'no-shared-auth')
    }
    if (!mcpDone) {
      writeCompletedMarker(mcpMarkerPath, 'no-shared-auth')
    }
    return
  }

  const candidates = hostAccounts.map((account) =>
    readTrustedAccountAuth(account, managedAccountsRoot, systemCodexHome)
  )
  const matches = candidates.filter(({ account, authContents }) =>
    codexAuthMatchesManagedAccount(sharedAuthContents, account, authContents)
  )
  // Why: a stale PTY can leave another account in the shared mirror. Only a
  // unique identity can prove which account home owns these bytes.
  if (matches.length !== 1 || matches[0].account.id !== activeHostAccountId) {
    return
  }

  const match = matches[0]
  if (match.authContents === null || match.authPath === null || match.homePath === null) {
    return
  }

  // Why: Codex file-mode MCP OAuth tokens live in $CODEX_HOME/.credentials.json
  // (issue #8440), keyed by MCP server URL with no account identity of their
  // own. The uniquely-matched auth.json is the only proof this shared mirror is
  // the active account's, so carry its co-located MCP store into the same
  // per-account home or those servers silently need re-auth after upgrade.
  if (!mcpDone) {
    writeCompletedMarker(
      mcpMarkerPath,
      migrateSharedMcpCredentials(sharedRuntimeHome, match.homePath),
      match.account.id
    )
  }
  if (authDone) {
    return
  }

  if (match.authContents === sharedAuthContents) {
    writeCompletedMarker(authMarkerPath, 'already-current', match.account.id)
    return
  }
  const freshness = compareCodexAuthFreshness(sharedAuthContents, match.authContents)
  if (freshness === null) {
    return
  }
  if (freshness <= 0) {
    writeCompletedMarker(authMarkerPath, 'not-newer', match.account.id)
    return
  }

  // Why: replacing the file atomically with a 0600 temporary prevents a crash
  // from truncating the only proven-fresh credential or widening permissions.
  writeFileAtomically(match.authPath, sharedAuthContents, { mode: 0o600 })
  writeCompletedMarker(authMarkerPath, 'migrated', match.account.id)
}

function readTrustedAccountAuth(
  account: CodexManagedAccount,
  managedAccountsRoot: string,
  systemCodexHome: string
): TrustedAccountAuth {
  let trustedHome: string
  try {
    trustedHome = assertOwnedHostCodexManagedHomePath({
      candidatePath: account.managedHomePath,
      managedAccountsRoot,
      systemCodexHomePath: systemCodexHome,
      expectedAccountId: account.id
    })
  } catch (error) {
    // Why: one stale or unproven account home must not abort every other
    // account's migration. Stored identity fields keep this account in the
    // unique-ownership gate, but nothing inside its home is read or written.
    console.warn('[codex-legacy-auth-migration] Skipping untrusted managed account home:', error)
    return { account, authContents: null, authPath: null, homePath: null }
  }
  const authPath = join(trustedHome, 'auth.json')
  let authContents: string | null = null
  try {
    authContents = readRegularFile(authPath)
  } catch (error) {
    console.warn('[codex-legacy-auth-migration] Skipping unreadable managed auth.json:', error)
  }
  return { account, authContents, authPath, homePath: trustedHome }
}

// Why: MCP OAuth tokens have no identity claim to match on, so we only ever
// write the shared store into the one identity-proven account's home, and never
// clobber a newer .credentials.json that account authed in its own home going
// forward. Absent source is a plain no-op.
function migrateSharedMcpCredentials(
  sharedRuntimeHome: string,
  perAccountHome: string
): 'migrated' | 'no-shared-credentials' | 'per-account-present' {
  const sharedCredentials = readRegularFile(join(sharedRuntimeHome, '.credentials.json'))
  if (sharedCredentials === null) {
    return 'no-shared-credentials'
  }
  const perAccountCredentialsPath = join(perAccountHome, '.credentials.json')
  if (regularFileState(perAccountCredentialsPath) === 'present') {
    return 'per-account-present'
  }
  // Why: atomic 0600 write mirrors auth.json so a crash cannot leave a partial
  // MCP store or widen permissions on sensitive tokens.
  writeFileAtomically(perAccountCredentialsPath, sharedCredentials, { mode: 0o600 })
  return 'migrated'
}

function readRegularFile(filePath: string): string | null {
  const state = regularFileState(filePath)
  return state === 'missing' ? null : readFileSync(filePath, 'utf-8')
}

function regularFileState(filePath: string): 'missing' | 'present' {
  try {
    if (!lstatSync(filePath).isFile()) {
      throw new Error(`Refusing non-regular Codex migration file: ${filePath}`)
    }
    return 'present'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing'
    }
    throw error
  }
}

function writeCompletedMarker(
  markerPath: string,
  outcome: CompletedOutcome,
  accountId?: string
): void {
  writeFileAtomically(
    markerPath,
    `${JSON.stringify({ completedAt: Date.now(), outcome, accountId })}\n`,
    { mode: 0o600 }
  )
}
