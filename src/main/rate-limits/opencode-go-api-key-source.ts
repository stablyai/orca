import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases
} from '../opencode-usage/opencode-database-discovery'
import { tableExists } from '../opencode-usage/schema-helpers'
import { isWslUncPath } from '../../shared/wsl-paths'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import Database from '../sqlite/sync-database'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import {
  detectOpenCodeCredentialBackend,
  type OpenCodeCredentialBackend
} from '../opencode/opencode-credential-backend'

/** OpenCode's provider/integration id for the Go subscription. */
const OPENCODE_GO_INTEGRATION_ID = 'opencode-go'
/** models.dev declares this env var for both `opencode` and `opencode-go`. */
const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'
const AUTH_FILE_NAME = 'auth.json'
const MAX_AUTH_FILE_BYTES = 1_000_000

/** Where the key came from. Safe to log — never carries the key itself. */
export type OpenCodeGoApiKeyTier =
  | 'settings'
  | 'environment'
  | 'opencode-auth-content'
  | 'opencode-auth-file'
  | 'opencode-credential-database'

export type OpenCodeGoApiKeyResolution =
  | { status: 'found'; key: string; tier: OpenCodeGoApiKeyTier }
  | { status: 'missing' }
  /** A credential database failed to read while OPENCODE_API_KEY was set. */
  | { status: 'credential-database-unreadable' }

export type OpenCodeCredentialDatabaseGoKeyRead =
  | { status: 'found'; key: string }
  | { status: 'missing' }
  | { status: 'unreadable' }

export function getOpenCodeAuthFilePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string
): string {
  return join(resolveOpenCodeDataDirectory(environment, homeDirectory), AUTH_FILE_NAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `{ type: <kind>, key: "…" }` from an already-narrowed record. */
function keyFromCredentialRecord(value: unknown, kind: string): string | null {
  if (!isRecord(value) || value.type !== kind) {
    return null
  }
  return trimmedKey(value.key)
}

function trimmedKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readOpenCodeInlineGoKey(environment: NodeJS.ProcessEnv): {
  configured: boolean
  key: string | null
} {
  const content = environment.OPENCODE_AUTH_CONTENT
  if (content) {
    try {
      const parsed: unknown = JSON.parse(content)
      return {
        configured: true,
        key: isRecord(parsed)
          ? keyFromCredentialRecord(parsed[OPENCODE_GO_INTEGRATION_ID], 'api')
          : null
      }
    } catch {
      // V1 ignores invalid inline JSON and then reads auth.json.
    }
  }
  return { configured: false, key: null }
}

/**
 * Read the `opencode-go` API key OpenCode 1.x writes on `/connect`.
 *
 * Shape (opencode `packages/opencode/src/auth/index.ts`, `Api` schema):
 * `{ "opencode-go": { "type": "api", "key": "…" } }`.
 * @returns The key, or null when the file, the entry, or the key is absent.
 */
export function readOpenCodeAuthFileGoKey(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string
): string | null {
  const path = getOpenCodeAuthFilePath(environment, homeDirectory)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.length > MAX_AUTH_FILE_BYTES) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) {
      return null
    }
    return keyFromCredentialRecord(parsed[OPENCODE_GO_INTEGRATION_ID], 'api')
  } catch {
    return null
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function selectCredentialKey(database: Database.Database): string | null {
  if (!tableExists(database, 'credential')) {
    return null
  }
  // OpenCode marks the chosen credential per integration with `active = 1`;
  // newest wins among the rest (packages/core/src/credential.ts).
  const rows: unknown[] = database
    .prepare(
      'SELECT value FROM credential WHERE integration_id = ? ' +
        'ORDER BY active DESC, time_created DESC LIMIT 8'
    )
    .all(OPENCODE_GO_INTEGRATION_ID)
  for (const row of rows) {
    if (!isRecord(row) || typeof row.value !== 'string') {
      continue
    }
    try {
      const key = keyFromCredentialRecord(JSON.parse(row.value), 'key')
      if (key) {
        return key
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Read the `opencode-go` key from OpenCode's `credential` table.
 *
 * OpenCode 2 imports `auth.json` into SQLite once (migration
 * `20260805200742_import_legacy_credentials`) and every later `/connect` writes
 * only there, so a fresh OpenCode 2 install has no `auth.json` entry at all.
 * V1 also creates this table and can populate it through integration routes;
 * only a caller with V2 execution authority should use it for Go credentials.
 * @returns The key; `missing` when no database, table, or row carries one;
 * `unreadable` when discovery, opening, or querying failed without a key.
 */
export async function readOpenCodeCredentialDatabaseGoKey(
  environment: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeCredentialDatabaseGoKeyRead> {
  let sawUnreadable = false
  let paths: string[]
  try {
    const listed = await listOpenCodeDatabases(
      undefined,
      (path, error) => {
        // A UNC location is never opened here (below), so failing to list it is no evidence either.
        if (!isWslUncPath(path) && !isMissingPathError(error)) {
          sawUnreadable = true
        }
      },
      undefined,
      environment
    )
    paths = [...listed].sort(compareOpenCodeClaimPriority)
  } catch {
    return { status: 'missing' }
  }
  for (const path of paths) {
    // A synchronous open against a 9p/UNC share can hang the main process, and
    // the status bar is never worth that; the other tiers still apply.
    if (isWslUncPath(path)) {
      continue
    }
    let database: Database.Database | null = null
    try {
      database = new Database(path, { readonly: true, fileMustExist: true })
      database.pragma('query_only = ON')
      const key = selectCredentialKey(database)
      if (key) {
        return { status: 'found', key }
      }
    } catch {
      // A locked, WAL-index-less, or foreign-schema database may still hold the
      // key; a later database can still supply one.
      sawUnreadable = true
      continue
    } finally {
      database?.close()
    }
  }
  return { status: sawUnreadable ? 'unreadable' : 'missing' }
}

/**
 * Resolve the OpenCode Go API key in the documented precedence order.
 *
 * Settings wins before backend discovery. V1 uses inline auth or auth.json;
 * V2 gives its credential table precedence over the legacy file. Stored keys
 * outrank the shared OPENCODE_API_KEY environment variable in both backends.
 * An unknown backend can still use the shared environment key, but no store.
 * An unreadable V2 database withholds the env key, which may belong to Zen.
 * @param input.settingsOverride - The key a user saved in Orca's settings.
 * @param input.environment - Process environment to read; injectable for tests.
 * @returns The key and its tier, `missing`, or `credential-database-unreadable`.
 */
export async function resolveOpenCodeGoApiKey(input: {
  settingsOverride?: string
  environment?: NodeJS.ProcessEnv
  backend?: OpenCodeCredentialBackend
  cwd?: string
}): Promise<OpenCodeGoApiKeyResolution> {
  const override = trimmedKey(input.settingsOverride)
  if (override) {
    return { status: 'found', key: override, tier: 'settings' }
  }
  const environment = input.environment ?? { ...process.env }
  if (!input.environment) {
    const accounts = getManagedDataAccountService()
    accounts.restoreOriginalEnvironment(environment)
    Object.assign(environment, accounts.launchEnvironment('opencode'))
  }
  const backend = input.backend ?? (await detectOpenCodeCredentialBackend(environment, input.cwd))
  let databaseUnreadable = false
  if (backend === 'v2') {
    const fromDatabase = await readOpenCodeCredentialDatabaseGoKey(environment)
    if (fromDatabase.status === 'found') {
      return { status: 'found', key: fromDatabase.key, tier: 'opencode-credential-database' }
    }
    databaseUnreadable = fromDatabase.status === 'unreadable'
  }
  const inline = backend === 'v1' ? readOpenCodeInlineGoKey(environment) : null
  if (inline?.key) {
    return { status: 'found', key: inline.key, tier: 'opencode-auth-content' }
  }
  const fromAuthFile =
    backend && !inline?.configured ? readOpenCodeAuthFileGoKey(environment) : null
  if (fromAuthFile) {
    return { status: 'found', key: fromAuthFile, tier: 'opencode-auth-file' }
  }
  const fromEnvironment = trimmedKey(environment[OPENCODE_API_KEY_ENV])
  if (fromEnvironment && databaseUnreadable) {
    return { status: 'credential-database-unreadable' }
  }
  if (fromEnvironment) {
    return { status: 'found', key: fromEnvironment, tier: 'environment' }
  }
  return { status: 'missing' }
}
