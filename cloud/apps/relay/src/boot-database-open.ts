import { openRelayDatabase, type RelayDatabase, type RelayDatabaseOpenInput } from './database.js'
import { retryTransientDatabaseStartup } from './database-startup-retry.js'
import {
  isPostgresPoolConnectFailure,
  isPostgresPoolConnectTimeout
} from './postgres-pool-pressure.js'
import { postgresErrorCodeCategory } from './postgres-query-failure.js'

// Retry only unreachable PostgreSQL. Reapplying DDL after lock/statement/capacity errors (55P03/57014/53300) requeues ahead of writers, so these remain terminal at boot.
function isBootDatabaseUnreachable(error: unknown): boolean {
  const code = postgresErrorCodeCategory(error)
  return isPostgresPoolConnectFailure(error) || code === '08001' || code === '08006'
}

// Proxy cold starts can exceed the request pool’s 2s connect timeout; retry longer than cold start but shorter than the restart loop.
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
