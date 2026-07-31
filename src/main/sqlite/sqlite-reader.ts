import type {
  SqliteCell,
  SqliteDatabaseOverview,
  SqliteTableInfo,
  SqliteTablePage
} from '../../shared/sqlite-database'
import Database, { type SqliteStatement } from './sync-database'

export const MAX_CELL_TEXT_CHARS = 2000
// Width multiplies per-cell truncation, so the budget shrinks with it. No floor: a floor would break this bound.
export const MAX_RESPONSE_TEXT_CHARS = 4 * 1024 * 1024

type ColumnRow = { name: string; pk: number; hidden: number }

// hidden=1 is a virtual-table column that SELECT * omits (FTS5, RTREE); 2 and 3 are generated columns, which it returns.
const HIDDEN_FROM_SELECT_STAR = 1

const VIRTUAL_TABLE_MODULE = /^\s*create\s+virtual\s+table\s+.*?\busing\s+([a-z0-9_]+)/i

// Suffixes each built-in module declares via xShadowName. Matching the owning module too, rather than the name prefix
// alone, keeps a user table like `docs_archive` visible next to an fts5 `docs`.
const SHADOW_SUFFIXES: Record<string, Set<string>> = {
  fts3: new Set(['content', 'docsize', 'segdir', 'segments', 'stat']),
  fts4: new Set(['content', 'docsize', 'segdir', 'segments', 'stat']),
  fts5: new Set(['config', 'content', 'data', 'docsize', 'idx']),
  rtree: new Set(['node', 'parent', 'rowid']),
  rtree_i32: new Set(['node', 'parent', 'rowid'])
}

function parseVirtualTableModule(sql: string | null): string | null {
  return VIRTUAL_TABLE_MODULE.exec(sql ?? '')?.[1]?.toLowerCase() ?? null
}

// A shadow table is a virtual table's private storage; showing it invites reading index internals as if they were data.
function isShadowTable(name: string, modulesByTable: Map<string, string>): boolean {
  const separator = name.lastIndexOf('_')
  if (separator <= 0) {
    return false
  }
  const module = modulesByTable.get(name.slice(0, separator))
  // An unknown module gets the benefit of the doubt: showing an extra table beats hiding a real one.
  return module !== undefined && (SHADOW_SUFFIXES[module]?.has(name.slice(separator + 1)) ?? false)
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function cellTextBudget(columnCount: number, rowLimit: number): number {
  const cells = Math.max(1, columnCount * rowLimit)
  const perCell = Math.floor(MAX_RESPONSE_TEXT_CHARS / cells)
  return Math.max(1, Math.min(MAX_CELL_TEXT_CHARS, perCell))
}

export function toCell(value: unknown, maxChars: number = MAX_CELL_TEXT_CHARS): SqliteCell {
  if (value === null || value === undefined) {
    return { type: 'null', text: '' }
  }
  if (typeof value === 'bigint') {
    return { type: 'integer', text: value.toString() }
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', text: String(value) }
      : { type: 'real', text: String(value) }
  }
  if (typeof value === 'string') {
    return value.length > maxChars
      ? { type: 'text', text: value.slice(0, maxChars), truncated: true }
      : { type: 'text', text: value }
  }
  if (value instanceof Uint8Array) {
    return { type: 'blob', text: `BLOB (${formatByteSize(value.byteLength)})` }
  }
  return { type: 'text', text: String(value) }
}

// Via the repo's node:sqlite adapter, so SQLite itself handles WAL, WITHOUT ROWID, generated columns and defaults.
export class SqliteDatabaseReader {
  private readonly db: InstanceType<typeof Database>
  private readonly tableNames: string[]
  private readonly columnCache = new Map<string, string[]>()
  private readonly orderClauses = new Map<string, string>()

  private constructor(db: InstanceType<typeof Database>, tableNames: string[]) {
    this.db = db
    this.tableNames = tableNames
  }

  static open(filePath: string): SqliteDatabaseReader {
    const db = new Database(filePath, { readonly: true, fileMustExist: true })
    try {
      // The sqlite_ prefix is reserved, so filtering it hides only SQLite's own bookkeeping (e.g. sqlite_sequence).
      const rows = db
        .prepare(
          "select name, sql from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name"
        )
        .all() as { name: string; sql: string | null }[]
      const modulesByTable = new Map<string, string>()
      for (const row of rows) {
        const module = parseVirtualTableModule(row.sql)
        if (module !== null) {
          modulesByTable.set(row.name, module)
        }
      }
      const names = rows
        .filter((row) => !isShadowTable(row.name, modulesByTable))
        .map((row) => row.name)
      return new SqliteDatabaseReader(db, names)
    } catch (err) {
      db.close()
      throw err
    }
  }

  listTables(): SqliteTableInfo[] {
    return this.tableNames.map((name) => ({ name, columns: this.columnsOf(name) }))
  }

  // Resolved per table and cached: a fresh reader per IPC call must not pay a pragma for every table in the database.
  private columnsOf(tableName: string): string[] {
    const cached = this.columnCache.get(tableName)
    if (cached !== undefined) {
      return cached
    }
    // table_info omits generated columns; SELECT * returns them.
    const columns = (
      this.db.prepare(`pragma table_xinfo(${quoteIdentifier(tableName)})`).all() as ColumnRow[]
    )
      .filter((column) => column.hidden !== HIDDEN_FROM_SELECT_STAR)
      .map((column) => column.name)
    this.columnCache.set(tableName, columns)
    return columns
  }

  overview(): SqliteDatabaseOverview {
    return { tables: this.listTables() }
  }

  // Synchronous by necessity (node:sqlite has no async API) so it blocks the main thread; measured at ~35ms for 5M rows.
  countRows(tableName: string): number {
    const quoted = quoteIdentifier(this.requireTable(tableName))
    const row = this.read(`select count(*) as n from ${quoted}`).get() as { n: bigint | number }
    return Number(row.n)
  }

  readTablePage(tableName: string, offset: number, limit: number): SqliteTablePage {
    const name = this.requireTable(tableName)
    const columns = this.columnsOf(name)
    const statement = this.read(
      `select * from ${quoteIdentifier(name)} order by ${this.orderBy(name)} limit ? offset ?`
    )
    const budget = cellTextBudget(columns.length, limit)
    const rows = (statement.all(limit, offset) as Record<string, unknown>[]).map((row) =>
      columns.map((column) => toCell(row[column], budget))
    )
    return { columns, rows, offset }
  }

  close(): void {
    this.db.close()
  }

  // Guarantees only a sqlite_master name is ever interpolated into SQL.
  private requireTable(tableName: string): string {
    if (!this.tableNames.includes(tableName)) {
      throw new Error(`Table "${tableName}" does not exist in this database`)
    }
    return tableName
  }

  private read(sql: string): SqliteStatement {
    const statement = this.db.prepare(sql)
    // Without this node:sqlite throws on any integer outside the double range instead of returning it.
    if (typeof statement.setReadBigInts === 'function') {
      statement.setReadBigInts(true)
    }
    return statement
  }

  // Paging needs a total order: without it SQLite may serve one chunk from an index and the next from the table.
  private orderBy(tableName: string): string {
    const cached = this.orderClauses.get(tableName)
    if (cached !== undefined) {
      return cached
    }
    const quoted = quoteIdentifier(tableName)
    let clause: string
    try {
      this.db.prepare(`select rowid from ${quoted} limit 0`)
      clause = 'rowid'
    } catch {
      // WITHOUT ROWID tables have no rowid; their primary key is the row order.
      const keyColumns = (this.db.prepare(`pragma table_xinfo(${quoted})`).all() as ColumnRow[])
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => quoteIdentifier(column.name))
      if (keyColumns.length === 0) {
        throw new Error(`Table "${tableName}" has neither a rowid nor a primary key to page by`)
      }
      clause = keyColumns.join(', ')
    }
    this.orderClauses.set(tableName, clause)
    return clause
  }
}
