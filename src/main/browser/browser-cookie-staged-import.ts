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
      throw new Error('Staged cookie import has an invalid domain scope')
    }
    scopeDomains.push(row.domain)
  }
  if (scopeDomains.length === 0) {
    throw new Error('Staged cookie import has an invalid domain scope')
  }
  return importedDomainScope(scopeDomains)
}

// Why (STA-4797): the staged image is a copy of the live jar that may be replayed on the next cold
// start. Record the exact normalized import scope inside it so replay can merge only these rows into
// the then-current jar instead of replacing unrelated sessions with an older snapshot.
export function prepareStagedCookiesForImport(
  stagingDb: DatabaseSync,
  importScope: ImportedDomainScope
): void {
  if (importScope.exact.size === 0) {
    return
  }
  stagingDb.exec(
    `CREATE TABLE IF NOT EXISTS ${quotedIdentifier(IMPORT_SCOPE_TABLE)} (` +
      'domain TEXT PRIMARY KEY, format_version INTEGER NOT NULL)'
  )
  stagingDb.exec(`DELETE FROM ${quotedIdentifier(IMPORT_SCOPE_TABLE)}`)
  const insertScope = stagingDb.prepare(
    `INSERT INTO ${quotedIdentifier(IMPORT_SCOPE_TABLE)} (domain, format_version) VALUES (?, ?)`
  )
  for (const domain of importScope.exact) {
    insertScope.run(domain, IMPORT_SCOPE_FORMAT_VERSION)
  }

  const hostKeys = (
    stagingDb.prepare('SELECT DISTINCT host_key FROM cookies').all() as StagedHostKeyRow[]
  ).map((row) => row.host_key)
  const deleteByHostKey = stagingDb.prepare('DELETE FROM cookies WHERE host_key = ?')
  for (const hostKey of hostKeys) {
    if (isHostKeyInScope(hostKey, importScope)) {
      deleteByHostKey.run(hostKey)
    }
  }
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

/**
 * Applies a scoped staged import and returns false for a legacy unmarked whole-image replay.
 *
 * Why: one transaction covers every scoped delete and insert. A failure or crash therefore leaves
 * the current live jar unchanged; after a committed crash, replay is idempotent and still cannot
 * touch an unrelated host key.
 */
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
      throw new Error('Staged cookie import has an incompatible cookie schema')
    }
    // Why: partial column intersections can silently erase a partition key or fill a newly required
    // column with the wrong default after an app update. Exact schema parity is the safe boundary.
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
    // A missing-live replay may have copied a full marked image on an earlier interrupted start.
    // Never leave that marker in Chromium's live DB where a downgrade could propagate it.
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
