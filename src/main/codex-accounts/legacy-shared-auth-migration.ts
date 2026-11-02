import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { writeFileAtomically } from './fs-utils'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'
import { codexAuthMatchesManagedAccount, compareCodexAuthFreshness } from './codex-auth-identity'

export const LEGACY_SHARED_AUTH_MIGRATION_MARKER = 'per-account-auth-migration-v1.json'
// MCP migration needs its own marker for upgrades that already completed auth-only migration (#8440).
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
    // MCP tokens have no identity claims; missing shared auth rules out both migrations.
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
  // Stale PTYs may leave another account's auth; require a unique match to the active account.
  if (matches.length !== 1 || matches[0].account.id !== activeHostAccountId) {
    return
  }

  const match = matches[0]
  if (match.authContents === null || match.authPath === null || match.homePath === null) {
    return
  }

  // Carry identity-free MCP tokens only alongside this proven account's auth (#8440).
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
    // Keep stored identity in the uniqueness check without accessing an untrusted home.
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
