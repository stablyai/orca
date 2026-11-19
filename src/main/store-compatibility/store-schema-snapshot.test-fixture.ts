import type Database from '../sqlite/sync-database'

/** [name, declared type, NOT NULL, default SQL, primary-key position] */
export type StoreColumnShape = [string, string, boolean, string | null, number]

export type StoreTableShape = { columns: StoreColumnShape[]; checks: string[] }
export type StoreIndexShape = { table: string; unique: boolean; sql: string | null }
export type StoreTriggerShape = { table: string; sql: string }

export type StoreSchemaSnapshot = {
  userVersion: number
  tables: Record<string, StoreTableShape>
  indexes: Record<string, StoreIndexShape>
  triggers: Record<string, StoreTriggerShape>
}

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null }
type ColumnRow = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/** Every CHECK (...) clause in a CREATE TABLE, with balanced parentheses. */
export function tableCheckClauses(sql: string): string[] {
  const checks: string[] = []
  const pattern = /\bCHECK\s*\(/gi
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    let depth = 1
    let end = match.index + match[0].length
    while (end < sql.length && depth > 0) {
      depth += sql[end] === '(' ? 1 : sql[end] === ')' ? -1 : 0
      end++
    }
    checks.push(normalizeSql(sql.slice(match.index, end)))
  }
  return checks.sort()
}

/** The schema an older writer depends on, in a stable order. */
export function readStoreSchemaSnapshot(db: Database.Database): StoreSchemaSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sqlite_schema rows have these TEXT columns.
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all() as SchemaRow[]
  const snapshot: StoreSchemaSnapshot = {
    userVersion: Number(db.pragma('user_version', { simple: true })),
    tables: {},
    indexes: {},
    triggers: {}
  }
  for (const row of rows) {
    if (row.type === 'table' && row.sql) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: table_info rows have these columns.
      const columns = db.prepare('SELECT * FROM pragma_table_info(?)').all(row.name) as ColumnRow[]
      snapshot.tables[row.name] = {
        columns: columns.map((column) => [
          column.name,
          column.type.toUpperCase(),
          column.notnull === 1,
          column.dflt_value,
          column.pk
        ]),
        checks: tableCheckClauses(row.sql)
      }
    } else if (row.type === 'index') {
      snapshot.indexes[row.name] = {
        table: row.tbl_name,
        unique: row.sql !== null && /^\s*CREATE\s+UNIQUE\b/i.test(row.sql),
        sql: row.sql === null ? null : normalizeSql(row.sql)
      }
    } else if (row.type === 'trigger' && row.sql) {
      snapshot.triggers[row.name] = { table: row.tbl_name, sql: normalizeSql(row.sql) }
    }
  }
  return snapshot
}
