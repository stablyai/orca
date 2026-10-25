import type { StatementResultingChanges } from 'node:sqlite'
import { SqliteIntegerReader } from './sqlite-integer-reader'
import type { SqliteBindings, SqliteRow, SqliteStatement } from './sqlite-statement'

export class NodeSqliteStatement implements SqliteStatement {
  private readonly integers = new SqliteIntegerReader()

  constructor(private readonly statement: SqliteStatement) {
    // Native number reads overflow their INT64_MIN guard on some builds and round insert rowids.
    statement.setReadBigInts(true)
  }

  all(...parameters: SqliteBindings): SqliteRow[] {
    const rows = this.statement.all(...parameters)
    for (const row of rows) {
      this.integers.row(row)
    }
    return rows
  }

  get(...parameters: SqliteBindings): SqliteRow | undefined {
    const row = this.statement.get(...parameters)
    return row === undefined ? undefined : this.integers.row(row)
  }

  run(...parameters: SqliteBindings): StatementResultingChanges {
    return this.integers.result(this.statement.run(...parameters))
  }

  *iterate(...parameters: SqliteBindings): IterableIterator<SqliteRow> {
    for (const row of this.statement.iterate(...parameters)) {
      yield this.integers.row(row)
    }
  }

  setReadBigInts(enabled: boolean): void {
    this.integers.readBigInts = enabled
  }
}
