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
  // Runs before each delayed statement leaves the client, so it sees the locks
  // the transaction holds between round trips.
  beforeTrip?: (sql: string) => Promise<void>
}

// The serving pool's session settings with a fixed delay in front of every
// statement, BEGIN and COMMIT included: one delay per cross-region round trip.
export function openDelayedPostgresDatabase(
  url: string,
  delay: StatementDelay,
  poolMax = 4
): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    // Same bound as openRelayDatabase, so a saturated pool fails acquires the
    // way a serving cell does instead of queueing forever.
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
