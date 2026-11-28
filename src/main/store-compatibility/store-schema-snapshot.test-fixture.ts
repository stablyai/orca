import { z } from 'zod'
import type Database from '../sqlite/sync-database'

/** [name, declared type, NOT NULL, default SQL, primary-key position, hidden/generated kind, generated expression] */
export type StoreColumnShape = [
  string,
  string,
  boolean,
  string | null,
  number,
  number,
  string | null
]

export type StoreTableShape = {
  columns: StoreColumnShape[]
  withoutRowid: boolean
  strict: boolean
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
const TableListRow = z.object({ wr: z.number(), strict: z.number() })
const IndexListRow = z.object({ name: z.string(), unique: z.number() })
const IndexColumnRow = z.object({ name: z.string().nullable() })

/** The text that closes each SQL quote or comment opener. */
const SQL_CLOSERS: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  '`': '`',
  '[': ']',
  '--': '\n',
  '/*': '*/'
}

/** SQLite's whitespace; other Unicode spaces can be part of an unquoted name. */
const SQL_WHITESPACE = /[ \t\n\v\f\r]/

/**
 * `sql` with comments blanked to spaces; `shape` also masks the inside of each literal and quoted name, so
 * patterns can't match across them. `code` says whether a character is outside every literal and quoted name.
 */
function sqlCode(sql: string): { text: string; shape: string; code: boolean[] } {
  let text = ''
  let shape = ''
  const code: boolean[] = []
  for (let i = 0; i < sql.length;) {
    const opener = SQL_CLOSERS[sql.slice(i, i + 2)] ? sql.slice(i, i + 2) : sql[i]
    const closer = SQL_CLOSERS[opener]
    if (!closer) {
      text += sql[i]
      shape += sql[i]
      code.push(true)
      i++
      continue
    }
    const found = sql.indexOf(closer, i + opener.length)
    const end = found === -1 ? sql.length : found + closer.length
    const comment = opener === '--' || opener === '/*'
    for (let j = i; j < end; j++) {
      text += comment ? ' ' : sql[j]
      const edge = j === i || (j === end - 1 && found !== -1)
      shape += comment ? ' ' : edge ? sql[j] : '_'
      code.push(comment)
    }
    i = end
  }
  return { text, shape, code }
}

/** Collapse whitespace and drop comments in SQL code; literals and quoted names stay as written. */
export function normalizeSql(sql: string): string {
  const { text, code } = sqlCode(sql)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += code[i] && SQL_WHITESPACE.test(text[i]) ? (out.endsWith(' ') ? '' : ' ') : text[i]
  }
  return out.trim()
}

/** A column name as SQLite reports it: quotes removed and doubled quotes undone. */
function unquoteSqlName(name: string): string {
  const quote = name[0]
  if (quote === '"' || quote === '`') {
    return name.slice(1, -1).replaceAll(quote + quote, quote)
  }
  return quote === '[' ? name.slice(1, -1) : name
}

/** Every CHECK (...) clause in a CREATE TABLE; comments, and parentheses inside literals, don't count. */
export function tableCheckClauses(sql: string): string[] {
  return parenthesizedClauses(sql, /\bCHECK\s*\(/gi)
    .map(([, clause]) => clause)
    .sort()
}

/** Each generated column's `AS (...)` expression, keyed by the column name before it. */
function generatedColumnExpressions(sql: string): Map<string, string> {
  return new Map(
    parenthesizedClauses(
      sql,
      /("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\w+)(?:\([^()]*\)|[^,(])*?\bAS\s*\(/gi,
      true
    ).map(([name, clause]) => [unquoteSqlName(name), clause])
  )
}

/** An unread expression would compare equal on both sides, so it fails loudly instead. */
function generatedExpression(
  generated: Map<string, string>,
  table: string,
  column: string
): string {
  const expression = generated.get(column)
  if (expression === undefined) {
    throw new Error(`Could not read the generated expression of ${table}.${column}`)
  }
  return expression
}

/** [first capture group, normalized clause] for each match of `pattern`, which must end at an open parenthesis; expressionOnly keeps just that parenthesized part. */
function parenthesizedClauses(
  sql: string,
  pattern: RegExp,
  expressionOnly = false
): [string, string][] {
  const clauses: [string, string][] = []
  const { text, shape, code } = sqlCode(sql)
  for (let match = pattern.exec(shape); match; match = pattern.exec(shape)) {
    if (!code[match.index + match[0].length - 1]) {
      continue
    }
    let depth = 1
    let end = match.index + match[0].length
    for (; end < text.length && depth > 0; end++) {
      if (code[end]) {
        depth += shape[end] === '(' ? 1 : shape[end] === ')' ? -1 : 0
      }
    }
    const start = expressionOnly ? match.index + match[0].length - 1 : match.index
    const name = text.slice(match.index, match.index + (match[1]?.length ?? 0))
    clauses.push([name, normalizeSql(text.slice(start, end))])
  }
  return clauses
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
  const generated = generatedColumnExpressions(sql)
  const options = TableListRow.parse(db.prepare('SELECT * FROM pragma_table_list(?)').get(table))
  return {
    withoutRowid: options.wr === 1,
    strict: options.strict === 1,
    columns: columns.map((column) => [
      column.name,
      column.type.toUpperCase(),
      column.notnull === 1,
      column.dflt_value,
      column.pk,
      column.hidden,
      column.hidden >= 2 ? generatedExpression(generated, table, column.name) : null
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
