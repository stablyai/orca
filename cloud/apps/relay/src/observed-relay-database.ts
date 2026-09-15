import type {
  RelayDatabase,
  RelayLockOptions,
  RelayTransactionOptions,
  SqlRow
} from './database.js'
import { timedRelayOperation, type RelayRuntimeObserver } from './relay-observability.js'

export function observeRelayDatabase(
  database: RelayDatabase,
  observer: RelayRuntimeObserver
): RelayDatabase {
  const query = (sql: string, params?: unknown[]): Promise<SqlRow[]> =>
    timedRelayOperation(
      () => database.query(sql, params),
      (durationMs, success) => observer.recordSql(durationMs, success)
    )
  const queryLocked = (
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> =>
    timedRelayOperation(
      () => database.queryLocked(sql, params, options),
      (durationMs, success) => observer.recordSql(durationMs, success),
      (error) =>
        // NOWAIT contention is an intentional sweep deferral, not a SQL-health failure.
        options?.failIfUnavailable === true &&
        error instanceof Error &&
        error.message === 'database_lock_unavailable'
    )
  return {
    dialect: database.dialect,
    query,
    queryLocked,
    transaction: async <T>(
      operation: (transaction: RelayDatabase) => Promise<T>,
      options?: RelayTransactionOptions
    ): Promise<T> =>
      await database.transaction(
        async (transaction) => await operation(observeRelayDatabase(transaction, observer)),
        options
      ),
    close: async () => await database.close()
  }
}
