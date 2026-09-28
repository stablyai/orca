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
  | 'opencode-auth-file'
  | 'opencode-credential-database'

export type OpenCodeGoApiKeyResolution =
  | { status: 'found'; key: string; tier: OpenCodeGoApiKeyTier }
  | { status: 'missing' }

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
    // Why: a malformed or unreadable auth file is "no key here", not a fetch
    // failure — later tiers and the cookie path still deserve their turn.
    return null
  }
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
 * The table itself is not a version marker — 1.18.x creates it too (verified
 * empty on a real 1.18.16 install), so probe it regardless of version.
 * @returns The key, or null when no database, table, or row carries one.
 */
export async function readOpenCodeCredentialDatabaseGoKey(): Promise<string | null> {
  let paths: string[]
  try {
    paths = [...(await listOpenCodeDatabases())].sort(compareOpenCodeClaimPriority)
  } catch {
    return null
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
        return key
      }
    } catch {
      // A locked, WAL-index-less, or foreign-schema database is not an error
      // here; it just holds no key we can read.
      continue
    } finally {
      database?.close()
    }
  }
  return null
}

/**
 * Resolve the OpenCode Go API key in the documented precedence order.
 *
 * Settings override, then whatever OpenCode itself stored on `/connect` —
 * `auth.json`, then the `credential` table — then `OPENCODE_API_KEY`. Both
 * stores are probed on every version: 1.18.x creates the `credential` table too,
 * so its presence is not a 2.x marker, and a 2.x install that never ran the
 * legacy import has no `auth.json` at all.
 * The stored key outranks the env var because OpenCode applies it after env,
 * and the env var is shared with the Zen provider.
 * @param input.settingsOverride - The key a user pasted into Orca's settings.
 * @param input.environment - Process environment to read; injectable for tests.
 * @returns The first key found and the tier it came from, or `missing`.
 */
export async function resolveOpenCodeGoApiKey(input: {
  settingsOverride?: string
  environment?: NodeJS.ProcessEnv
}): Promise<OpenCodeGoApiKeyResolution> {
  const environment = input.environment ?? process.env
  const override = trimmedKey(input.settingsOverride)
  if (override) {
    return { status: 'found', key: override, tier: 'settings' }
  }
  const fromAuthFile = readOpenCodeAuthFileGoKey(environment)
  if (fromAuthFile) {
    return { status: 'found', key: fromAuthFile, tier: 'opencode-auth-file' }
  }
  const fromDatabase = await readOpenCodeCredentialDatabaseGoKey()
  if (fromDatabase) {
    return { status: 'found', key: fromDatabase, tier: 'opencode-credential-database' }
  }
  const fromEnvironment = trimmedKey(environment[OPENCODE_API_KEY_ENV])
  if (fromEnvironment) {
    return { status: 'found', key: fromEnvironment, tier: 'environment' }
  }
  return { status: 'missing' }
}
