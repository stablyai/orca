import type { StatementResultingChanges } from 'node:sqlite'
import type { SqliteRow } from './sqlite-statement'

export class SqliteIntegerReader {
  readBigInts = false

  row(row: SqliteRow): SqliteRow {
    if (!this.readBigInts) {
      for (const key of Object.keys(row)) {
        const value = row[key]
        if (typeof value === 'bigint') {
          row[key] = this.integer(value)
        }
      }
    }
    return row
  }

  result(result: StatementResultingChanges): StatementResultingChanges {
    return {
      changes: this.integer(result.changes, false),
      lastInsertRowid: this.integer(result.lastInsertRowid, false)
    }
  }

  private integer(value: number | bigint, requireSafeNumber = true): number | bigint {
    if (this.readBigInts) {
      return BigInt(value)
    }
    const number = Number(value)
    if (!Number.isSafeInteger(number)) {
      // Metadata conversion must not report failure after a write has committed.
      if (!requireSafeNumber) {
        return BigInt(value)
      }
      throw new RangeError('SQLite integer cannot be represented safely as a JavaScript number')
    }
    return number
  }
}
