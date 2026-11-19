import { z } from 'zod'
import type Database from '../sqlite/sync-database'

/** [name, declared type, NOT NULL, default SQL, primary-key position, hidden/generated kind] */
export type StoreColumnShape = [string, string, boolean, string | null, number, number]

export type StoreTableShape = {
  columns: StoreColumnShape[]
  checks: string[]
  /** "from->table(to) ON UPDATE x ON DELETE y", one per foreign-key column. */
  foreignKeys: string[]
  /** Column lists of every unique constraint, including ones declared inside CREATE TABLE. */
  uniqueKeys: string[]
}
export type StoreIndexShape = { table: string; unique: boolean; sql: string | null }
export type StoreTriggerShape = { table: string; sql: string }

export type StoreSchemaSnapshot = {
  userVersion: number
  tables: Record<string, StoreTableShape>
  indexes: Record<string, StoreIndexShape>
  triggers: Record<string, StoreTriggerShape>
  views: Record<string, string>
}

const SchemaRow = z.object({
  type: z.string(),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string().nullable()
})
const ColumnRow = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.string().nullable(),
  pk: z.number(),
  hidden: z.number()
})
const ForeignKeyRow = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  on_update: z.string(),
  on_delete: z.string()
})
const IndexListRow = z.object({ name: z.string(), unique: z.number() })
const IndexColumnRow = z.object({ name: z.string().nullable() })

/** Collapse whitespace outside SQL string literals and quoted names; literal text stays as written. */
export function normalizeSql(sql: string): string {
  let out = ''
  let quote: string | null = null
  for (const char of sql) {
    if (quote) {
      out += char
      quote = char === quote ? null : quote
    } else if (char === "'" || char === '"' || char === '`') {
      out += char
      quote = char
    } else if (/\s/.test(char)) {
      out += out.endsWith(' ') ? '' : ' '
    } else {
      out += char
    }
  }
  return out.trim()
}

/** Every CHECK (...) clause in a CREATE TABLE; parentheses inside literals don't count. */
export function tableCheckClauses(sql: string): string[] {
  const checks: string[] = []
  const pattern = /\bCHECK\s*\(/gi
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    let depth = 1
    let quote: string | null = null
    let end = match.index + match[0].length
    for (; end < sql.length && depth > 0; end++) {
      const char = sql[end]
      if (quote) {
        quote = char === quote ? null : quote
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char
      } else {
        depth += char === '(' ? 1 : char === ')' ? -1 : 0
      }
    }
    checks.push(normalizeSql(sql.slice(match.index, end)))
  }
  return checks.sort()
}

function tableShape(db: Database.Database, table: string, sql: string): StoreTableShape {
  const columns = db
    .prepare('SELECT * FROM pragma_table_xinfo(?)')
    .all(table)
    .map((row) => ColumnRow.parse(row))
  const foreignKeys = db
    .prepare('SELECT * FROM pragma_foreign_key_list(?)')
    .all(table)
    .map((row) => ForeignKeyRow.parse(row))
    .map(
      (key) =>
        `${key.from}->${key.table}(${key.to ?? ''}) ON UPDATE ${key.on_update} ON DELETE ${key.on_delete}`
    )
  const uniqueKeys = db
    .prepare('SELECT * FROM pragma_index_list(?)')
    .all(table)
    .map((row) => IndexListRow.parse(row))
    .filter((index) => index.unique === 1)
    .map((index) =>
      db
        .prepare('SELECT name FROM pragma_index_info(?)')
        .all(index.name)
        .map((row) => IndexColumnRow.parse(row).name ?? '<expr>')
        .join(',')
    )
  return {
    columns: columns.map((column) => [
      column.name,
      column.type.toUpperCase(),
      column.notnull === 1,
      column.dflt_value,
      column.pk,
      column.hidden
    ]),
    checks: tableCheckClauses(sql),
    foreignKeys: foreignKeys.sort(),
    uniqueKeys: uniqueKeys.sort()
  }
}

/** The schema an older writer depends on, in a stable order. */
export function readStoreSchemaSnapshot(db: Database.Database): StoreSchemaSnapshot {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all()
    .map((row) => SchemaRow.parse(row))
  const snapshot: StoreSchemaSnapshot = {
    userVersion: Number(db.pragma('user_version', { simple: true })),
    tables: {},
    indexes: {},
    triggers: {},
    views: {}
  }
  for (const row of rows) {
    if (row.type === 'table' && row.sql) {
      snapshot.tables[row.name] = tableShape(db, row.name, row.sql)
    } else if (row.type === 'index') {
      snapshot.indexes[row.name] = {
        table: row.tbl_name,
        unique: row.sql !== null && /^\s*CREATE\s+UNIQUE\b/i.test(row.sql),
        sql: row.sql === null ? null : normalizeSql(row.sql)
      }
    } else if (row.type === 'trigger' && row.sql) {
      snapshot.triggers[row.name] = { table: row.tbl_name, sql: normalizeSql(row.sql) }
    } else if (row.type === 'view' && row.sql) {
      snapshot.views[row.name] = normalizeSql(row.sql)
    }
  }
  return snapshot
}
