import pg from 'pg'
import {
  absorbPostgresIdleClientErrors,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
  PostgresDatabase
} from '../database.js'

export type StatementDelay = {
  enabled: boolean
  delayMs: number
  // Observe held locks before each delayed client round trip.
  beforeTrip?: (sql: string) => Promise<void>
}

// Inject cross-region delay before every statement, including BEGIN/COMMIT, with serving-pool settings.
export function openDelayedPostgresDatabase(
  url: string,
  delay: StatementDelay,
  poolMax = 4
): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    // Use serving acquire bound so pool saturation fails instead of queueing forever.
    connectionTimeoutMillis: 2_000,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 5_000
  })
  absorbPostgresIdleClientErrors(pool)
  pool.on('connect', (client) => {
    const query = client.query
    Object.assign(client, {
      query: async (...args: unknown[]) => {
        if (delay.enabled) {
          await delay.beforeTrip?.(typeof args[0] === 'string' ? args[0] : '')
          await new Promise((resolve) => setTimeout(resolve, delay.delayMs))
        }
        return await Reflect.apply(query, client, args)
      }
    })
  })
  return new PostgresDatabase(pool)
}
