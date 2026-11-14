import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

export type JournalSqlReadWork = { rows: number; decodedBytes: number }
export type JournalSqlIndexValues = {
  encode: (value: unknown, collection: string, key: string) => string
  decode: <T>(json: string) => T
  forget: (collection: string, key?: string) => void
}

export class JournalSqlScope {
  constructor(
    readonly db: Database.Database,
    readonly sessionId: string,
    readonly epoch: string,
    readonly work: JournalSqlReadWork = { rows: 0, decodedBytes: 0 },
    private readonly indexValues?: JournalSqlIndexValues,
    /** Fixed-size facts a read is handed stay in that read; only the writer saves them. */
    readonly snapshot = false
  ) {}

  get prefix(): [string, string] {
    return [this.sessionId, this.epoch]
  }

  examined(row: SqliteRow): SqliteRow {
    this.work.rows++
    return row
  }

  decode<T>(json: unknown): T {
    if (typeof json !== 'string') {
      throw new Error('Invalid journal projection value')
    }
    this.work.decodedBytes += Buffer.byteLength(json)
    return this.indexValues ? this.indexValues.decode<T>(json) : JSON.parse(json)
  }

  /** A projection row's own payload; never an index value pointer. */
  parse(json: string): unknown {
    this.work.decodedBytes += Buffer.byteLength(json)
    return JSON.parse(json)
  }

  encode(value: unknown, collection: string, key: string): string {
    return this.indexValues?.encode(value, collection, key) ?? JSON.stringify(value)
  }

  forget(collection: string, key?: string): void {
    this.indexValues?.forget(collection, key)
  }

  withIndexValues(values: JournalSqlIndexValues): JournalSqlScope {
    return new JournalSqlScope(
      this.db,
      this.sessionId,
      this.epoch,
      this.work,
      values,
      this.snapshot
    )
  }

  asSnapshot(): JournalSqlScope {
    return new JournalSqlScope(
      this.db,
      this.sessionId,
      this.epoch,
      this.work,
      this.indexValues,
      true
    )
  }
}
