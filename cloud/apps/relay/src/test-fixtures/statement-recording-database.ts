import type {
  RelayDatabase,
  RelayLockOptions,
  RelayTransactionOptions,
  SqlRow
} from '../database.js'

// Every statement a relay path issues, in order, so its round trips are counted rather than
// described. BEGIN and COMMIT are recorded too: each is a trip to a remote database.
export class StatementRecordingDatabase implements RelayDatabase {
  readonly dialect: RelayDatabase['dialect']
  // A statement this matches fails as a dropped connection would, before reaching the database.
  failing: ((sql: string) => boolean) | null = null

  constructor(
    private readonly inner: RelayDatabase,
    readonly statements: string[] = []
  ) {
    this.dialect = inner.dialect
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    this.statements.push(normalized(sql))
    if (this.failing?.(normalized(sql))) throw new Error('Connection terminated unexpectedly')
    return await this.inner.query(sql, params)
  }

  async queryLocked(sql: string, params: unknown[] = [], options: RelayLockOptions = {}): Promise<SqlRow[]> {
    this.statements.push(`${normalized(sql)} [locked]`)
    return await this.inner.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options: RelayTransactionOptions = {}
  ): Promise<T> {
    this.statements.push('BEGIN')
    try {
      return await this.inner.transaction(
        async (transaction) => {
          const recording = new StatementRecordingDatabase(transaction, this.statements)
          recording.failing = this.failing
          return await operation(recording)
        },
        options
      )
    } finally {
      this.statements.push('COMMIT')
    }
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}
