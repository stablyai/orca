import type { StatementResultingChanges } from 'node:sqlite'
import { SqliteIntegerReader } from './sqlite-integer-reader'
import type { SqliteBindings, SqliteRow, SqliteStatement } from './sqlite-statement'

// SQLite retains bound text/blob values until rebinding or statement finalization.
const LARGE_BINDING_BYTES = 64 * 1024

function hasLargeBinding(parameters: SqliteBindings): boolean {
  let bytes = 0
  for (const value of parameters) {
    bytes +=
      typeof value === 'string' ? value.length : ArrayBuffer.isView(value) ? value.byteLength : 0
    if (bytes > LARGE_BINDING_BYTES) {
      return true
    }
  }
  return false
}

export class NodeSqliteStatement implements SqliteStatement {
  private readonly integers = new SqliteIntegerReader()

  private readonly statement: SqliteStatement

  constructor(private readonly prepare: () => SqliteStatement) {
    this.statement = this.prepareStatement()
  }

  private prepareStatement(): SqliteStatement {
    const statement = this.prepare()
    // Native number reads overflow their INT64_MIN guard on some builds and round insert rowids.
    statement.setReadBigInts(true)
    return statement
  }

  private execution(parameters: SqliteBindings): SqliteStatement {
    return hasLargeBinding(parameters) ? this.prepareStatement() : this.statement
  }

  all(...parameters: SqliteBindings): SqliteRow[] {
    const rows = this.execution(parameters).all(...parameters)
    for (const row of rows) {
      this.integers.row(row)
    }
    return rows
  }

  get(...parameters: SqliteBindings): SqliteRow | undefined {
    const row = this.execution(parameters).get(...parameters)
    return row === undefined ? undefined : this.integers.row(row)
  }

  run(...parameters: SqliteBindings): StatementResultingChanges {
    return this.integers.result(this.execution(parameters).run(...parameters))
  }

  *iterate(...parameters: SqliteBindings): IterableIterator<SqliteRow> {
    let rows: IterableIterator<SqliteRow> | undefined
    try {
      rows = this.execution(parameters).iterate(...parameters)
      parameters.length = 0
      for (const row of rows) {
        yield this.integers.row(row)
      }
    } finally {
      rows = undefined
      parameters.length = 0
    }
  }

  setReadBigInts(enabled: boolean): void {
    this.integers.readBigInts = enabled
  }
}
