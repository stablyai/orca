// The credential store's tables as the relay creates them: read back from an in-memory relay
// database (schema plus migrations applied), so nothing is copied by hand. The Worker cannot import
// the relay's database module (pg, node:sqlite), so src/object-store-schema.generated.ts holds the
// result. Regenerate:
//   UPDATE_OBJECT_STORE_SCHEMA=1 ./node_modules/.bin/tsx test/generate-object-store-schema.ts
import { openInMemoryRelayDatabase } from '../../relay/src/database/database'

export const OBJECT_STORE_TABLES = [
  'relay_invites',
  'relay_devices',
  'relay_install_results',
  'relay_connection_bases',
  'relay_direct_authorizations',
  'relay_confirm_results',
  'relay_audit_events',
  'relay_rate_windows'
] as const

export async function relayObjectStoreSchema(): Promise<string[]> {
  const database = await openInMemoryRelayDatabase()
  try {
    const marks = OBJECT_STORE_TABLES.map(() => '?').join(', ')
    const rows = await database.query(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN (${marks}) AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
      [...OBJECT_STORE_TABLES]
    )
    const created = new Set(rows.filter((r) => r.type === 'table').map((r) => r.name))
    for (const table of OBJECT_STORE_TABLES) { if (!created.has(table)) { throw new Error(`object_store_schema_missing_${table}`) } }
    return rows.map((r) =>
      String(r.sql)
        .replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
        .replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i, (_m, u) => `CREATE ${u ?? ''}INDEX IF NOT EXISTS `)
    )
  } finally {
    await database.close()
  }
}
