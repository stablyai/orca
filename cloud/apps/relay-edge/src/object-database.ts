// The relay's RelayDatabase interface over a Durable Object's own SQLite, so the cells' credential
// store runs unchanged (SQLite dialect) inside HostRelay. Phase 2: no Postgres on the hot path.
// - query: `sql.exec`; writes answer [{ changes }] from SQLite's changes(), like node:sqlite.
// - transaction: the object's storage transaction (BEGIN/SAVEPOINT are refused in objects); it
//   rolls back every write when the operation throws. Nested calls join the open transaction.
// The store's queries are synchronous underneath, so nothing else runs inside a transaction.
import type { RelayDatabase, RelayLockOptions, SqlRow } from '../../relay/src/database/database'
import { OBJECT_STORE_SCHEMA } from './object-store-schema.generated'

// The subset of SqlStorage this needs (a node:sqlite fake implements it in tests).
export type ObjectSql = {
  exec(sql: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] }
}
export type RunTransaction = <T>(operation: () => Promise<T>) => Promise<T>

function returnsRows(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
}

export class ObjectSqliteDatabase implements RelayDatabase {
  readonly dialect = 'sqlite' as const
  private inTransaction = false

  constructor(
    private readonly sql: ObjectSql,
    private readonly runTransaction: RunTransaction
  ) {}

  // Idempotent: CREATE ... IF NOT EXISTS.
  applySchema(): void {
    for (const statement of OBJECT_STORE_SCHEMA) { this.sql.exec(statement) }
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const bound = params.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value))
    const rows = this.sql.exec(sql, ...bound).toArray()
    if (returnsRows(sql)) { return rows as SqlRow[] }
    const changes = Number(this.sql.exec('SELECT changes() AS c').toArray()[0]?.c ?? 0)
    return [{ changes }]
  }

  async queryLocked(sql: string, params: unknown[] = [], _options: RelayLockOptions = {}): Promise<SqlRow[]> {
    // One object is one writer: SQLite has no row locks and needs none here.
    return this.query(sql, params)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    if (this.inTransaction) { return operation(this) }
    return this.runTransaction(async () => {
      this.inTransaction = true
      try {
        return await operation(this)
      } finally {
        this.inTransaction = false
      }
    })
  }

  async close(): Promise<void> {}
}
