import { DatabaseSync } from 'node:sqlite'
import type { ImportedDomainScope } from './browser-cookie-import-policy'
import {
  domainIsInImportedScope,
  importedDomainScope,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain,
  normalizeCookieImportDomain
} from './browser-cookie-import-policy'

const IMPORT_SCOPE_TABLE = 'orca_cookie_import_scope'
const IMPORT_SCOPE_FORMAT_VERSION = 1
export const SCOPED_COOKIE_IMPORT_FORMAT = `scoped-v${IMPORT_SCOPE_FORMAT_VERSION}`

export class InvalidStagedCookieImportError extends Error {}

export function isPermanentStagedCookieImportFailure(error: unknown): boolean {
  if (error instanceof InvalidStagedCookieImportError) {
    return true
  }
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return false
  }
  // SQL/schema errors, corrupt images and non-databases cannot become usable on retry.
  return typeof error.errcode === 'number' && [1, 11, 26].includes(error.errcode & 0xff)
}

type StagedHostKeyRow = { host_key: unknown }
type StagedScopeRow = { domain: unknown; format_version: unknown }
type SqliteColumnRow = { name: unknown }
type SqliteTableRow = { sql: unknown }

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function cookieColumns(database: DatabaseSync, schema: 'main' | 'staged_import'): string[] {
  return (database.prepare(`PRAGMA ${schema}.table_info(cookies)`).all() as SqliteColumnRow[])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string')
}

function cookieTableSql(database: DatabaseSync, schema: 'main' | 'staged_import'): string | null {
  const row = database
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'cookies'`)
    .get() as SqliteTableRow | undefined
  return typeof row?.sql === 'string' ? row.sql : null
}

function isHostKeyInScope(hostKey: unknown, scope: ImportedDomainScope): hostKey is string {
  if (typeof hostKey !== 'string' || isNonTransplantableCookieDomain(hostKey)) {
    return false
  }
  const domain = normalizeCookieDomain(hostKey)
  return domain !== null && domainIsInImportedScope(scope, domain, !hostKey.startsWith('.'))
}

function readImportedScope(
  database: DatabaseSync,
  schema: 'main' | 'staged_import'
): ImportedDomainScope | null {
  const marker = database
    .prepare(`SELECT 1 AS present FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(IMPORT_SCOPE_TABLE)
  if (!marker) {
    return null
  }
  const scopeRows = database
    .prepare(
      `SELECT domain, format_version FROM ${schema}.${quotedIdentifier(
        IMPORT_SCOPE_TABLE
      )} ORDER BY domain`
    )
    .all() as StagedScopeRow[]
  const scopeDomains: string[] = []
  for (const row of scopeRows) {
    if (
      row.format_version !== IMPORT_SCOPE_FORMAT_VERSION ||
      typeof row.domain !== 'string' ||
      normalizeCookieImportDomain(row.domain) !== row.domain
    ) {
      throw new InvalidStagedCookieImportError('Staged cookie import has an invalid domain scope')
    }
    scopeDomains.push(row.domain)
  }
  if (scopeDomains.length === 0) {
    throw new InvalidStagedCookieImportError('Staged cookie import has an invalid domain scope')
  }
  return importedDomainScope(scopeDomains)
}

export function isScopedStagedCookieImport(stagedCookiesPath: string): boolean {
  const database = new DatabaseSync(stagedCookiesPath, { readOnly: true })
  try {
    return readImportedScope(database, 'main') !== null
  } finally {
    database.close()
  }
}

export function removeCookieImportScopeMarker(liveCookiesPath: string): void {
  const database = new DatabaseSync(liveCookiesPath, { timeout: 1_000 })
  try {
    database.exec(`DROP TABLE IF EXISTS ${quotedIdentifier(IMPORT_SCOPE_TABLE)}`)
  } finally {
    database.close()
  }
}

/** Replay scoped deletes and inserts atomically; false identifies a legacy unmarked image. */
export function applyScopedStagedCookieImport(
  liveCookiesPath: string,
  stagedCookiesPath: string
): boolean {
  const database = new DatabaseSync(liveCookiesPath, { timeout: 1_000 })
  let attached = false
  let transactionOpen = false
  try {
    database.prepare('ATTACH DATABASE ? AS staged_import').run(stagedCookiesPath)
    attached = true
    const scope = readImportedScope(database, 'staged_import')
    if (!scope) {
      return false
    }

    const liveColumns = cookieColumns(database, 'main')
    const stagedColumns = cookieColumns(database, 'staged_import')
    if (
      !liveColumns.includes('host_key') ||
      cookieTableSql(database, 'main') !== cookieTableSql(database, 'staged_import') ||
      liveColumns.length !== stagedColumns.length ||
      liveColumns.some((column, index) => column !== stagedColumns[index])
    ) {
      throw new InvalidStagedCookieImportError(
        'Staged cookie import has an incompatible cookie schema'
      )
    }
    // Require schema parity to avoid dropping partition keys or guessing new column defaults.
    const columnList = liveColumns.map(quotedIdentifier).join(', ')
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const hostKeys = database
      .prepare('SELECT host_key FROM main.cookies UNION SELECT host_key FROM staged_import.cookies')
      .all() as StagedHostKeyRow[]
    const deleteLiveHost = database.prepare('DELETE FROM main.cookies WHERE host_key = ?')
    const insertStagedHost = database.prepare(
      `INSERT OR REPLACE INTO main.cookies (${columnList}) ` +
        `SELECT ${columnList} FROM staged_import.cookies WHERE host_key = ?`
    )

    for (const { host_key: hostKey } of hostKeys) {
      if (!isHostKeyInScope(hostKey, scope)) {
        continue
      }
      deleteLiveHost.run(hostKey)
      insertStagedHost.run(hostKey)
    }
    // Strip any replay marker copied by an interrupted startup before a downgrade can propagate it.
    database.exec(`DROP TABLE IF EXISTS main.${quotedIdentifier(IMPORT_SCOPE_TABLE)}`)
    database.exec('COMMIT')
    transactionOpen = false
    return true
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK')
      } catch {
        /* closing the database rolls back any transaction SQLite still owns */
      }
    }
    throw error
  } finally {
    if (attached) {
      try {
        database.exec('DETACH DATABASE staged_import')
      } catch {
        /* close releases the attached file even after a failed transaction */
      }
    }
    database.close()
  }
}
