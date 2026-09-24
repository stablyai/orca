import { openRelayDatabase, type RelayDatabase, type RelayDatabaseOpenInput } from './database.js'
import { retryTransientDatabaseStartup } from './database-startup-retry.js'
import {
  isPostgresPoolConnectFailure,
  isPostgresPoolConnectTimeout
} from './postgres-pool-pressure.js'
import { postgresErrorCodeCategory } from './postgres-query-failure.js'

// Only a failure to reach Postgres at all. A retry here re-runs the schema
// apply, and applyPostgresSchema refuses to repeat a DDL lock timeout on
// purpose: relation locks are granted in queue order, so a repeat parks every
// writer behind the same statement again. 55P03, 57014 and 53300 therefore stay
// terminal at boot even though the request path calls them transient.
function isBootDatabaseUnreachable(error: unknown): boolean {
  const code = postgresErrorCodeCategory(error)
  return isPostgresPoolConnectFailure(error) || code === '08001' || code === '08006'
}

// A cell boots beside a cloud-sql-proxy that is itself still dialling, so the
// first pool acquire can outrun the 2s connect timeout that protects the
// request path. The window is longer than a proxy cold start and shorter than
// the restart loop it replaces.
const BOOT_OPEN_RETRY = {
  attempts: 20,
  windowMs: 45_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitterMs: 250,
  isRetryable: isBootDatabaseUnreachable
}

function bootDatabaseErrorFields(error: unknown): Record<string, unknown> {
  return {
    code: postgresErrorCodeCategory(error),
    connectionTimeout: isPostgresPoolConnectTimeout(error)
  }
}

export async function openRelayDatabaseAtBoot(
  input: RelayDatabaseOpenInput,
  open: (input: RelayDatabaseOpenInput) => Promise<RelayDatabase> = openRelayDatabase
): Promise<RelayDatabase> {
  return await retryTransientDatabaseStartup(
    async () => await open(input),
    BOOT_OPEN_RETRY,
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          JSON.stringify({
            event: 'orca_relay_boot_database_retry',
            attempt,
            delayMs,
            ...bootDatabaseErrorFields(error)
          })
        ),
      onRecovered: ({ attempts }) =>
        console.warn(
          JSON.stringify({ event: 'orca_relay_boot_database_recovered', attempts })
        ),
      onGaveUp: ({ attempts, error, retryable }) =>
        console.warn(
          JSON.stringify({
            event: 'orca_relay_boot_database_failed',
            attempts,
            retryable,
            ...bootDatabaseErrorFields(error)
          })
        )
    }
  )
}
