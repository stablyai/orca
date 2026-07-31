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

type ColumnRow = { name: string; pk: number }

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
  private readonly tables: Map<string, string[]>
  private readonly orderClauses = new Map<string, string>()

  private constructor(db: InstanceType<typeof Database>, tables: Map<string, string[]>) {
    this.db = db
    this.tables = tables
  }

  static open(filePath: string): SqliteDatabaseReader {
    const db = new Database(filePath, { readonly: true, fileMustExist: true })
    try {
      const names = (
        db.prepare("select name from sqlite_master where type = 'table' order by name").all() as {
          name: string
        }[]
      ).map((row) => row.name)

      const tables = new Map<string, string[]>()
      for (const name of names) {
        // table_info omits generated columns; SELECT * returns them.
        const columns = db
          .prepare(`pragma table_xinfo(${quoteIdentifier(name)})`)
          .all() as ColumnRow[]
        tables.set(
          name,
          columns.map((column) => column.name)
        )
      }
      return new SqliteDatabaseReader(db, tables)
    } catch (err) {
      db.close()
      throw err
    }
  }

  listTables(): SqliteTableInfo[] {
    return [...this.tables.entries()].map(([name, columns]) => ({ name, columns }))
  }

  overview(): SqliteDatabaseOverview {
    return { tables: this.listTables() }
  }

  countRows(tableName: string): number {
    const quoted = quoteIdentifier(this.requireTable(tableName))
    const row = this.read(`select count(*) as n from ${quoted}`).get() as { n: bigint | number }
    return Number(row.n)
  }

  readTablePage(tableName: string, offset: number, limit: number): SqliteTablePage {
    const name = this.requireTable(tableName)
    const columns = this.tables.get(name)!
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
    if (!this.tables.has(tableName)) {
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
