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

const OPENCODE_GO_INTEGRATION_ID = 'opencode-go'
// models.dev shares this variable between OpenCode and Go.
const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'
const AUTH_FILE_NAME = 'auth.json'
const MAX_AUTH_FILE_BYTES = 1_000_000

/** Nonsecret source label, safe to log. */
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

/** OpenCode 1.x /connect stores opencode-go as an api record with a key in auth.json. */
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
  // Prefer active credentials, then newest entries (packages/core/src/credential.ts).
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

/** OpenCode 2 imports auth.json once, then /connect writes SQLite; fresh installs can have no legacy entry.
 * V1 can also populate the table, so only V2 execution authority may select it.
 * Distinguish absent keys from database discovery/open/query failures. */
export async function readOpenCodeCredentialDatabaseGoKey(
  environment: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeCredentialDatabaseGoKeyRead> {
  let sawUnreadable = false
  let paths: string[]
  try {
    const listed = await listOpenCodeDatabases(
      undefined,
      (path, error) => {
        // UNC databases are never opened here, so their listing failure supplies no read evidence.
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
    // Synchronous UNC database opens can hang main; leave other credential tiers available.
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
      // An unreadable/foreign/locked DB may hold a key; continue looking before declaring absence.
      sawUnreadable = true
      continue
    } finally {
      database?.close()
    }
  }
  return { status: sawUnreadable ? 'unreadable' : 'missing' }
}

/** Settings wins; V1 uses inline/file auth, V2 prefers SQLite, and stored keys outrank the shared env key.
 * Unknown backends may use only env; unreadable V2 databases withhold env because it may belong to Zen. */
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
