import type { RelayDatabase } from './database.js'
import type { DatabaseLockWaitSample } from './relay-observability.js'

// Every relay process connects as the same user through a socket, so neither
// pg_stat_statements nor Query Insights can tell a director's lock wait from a
// cell's. application_name (`orca-relay/<role>/<cell>`) can, so this samples it.
// The table is the first relay table the waiting statement names: its FROM or
// UPDATE target, not a table it only joins. Plain read of shared state: no relay
// row is locked, and pg_blocking_pids runs only for backends already waiting.
const LOCK_WAIT_SAMPLE_SQL = `
SELECT split_part(waiter.application_name, '/', 2) AS waiter_role,
       COALESCE(
         substring(waiter.query FROM '\\m(relay_cells|relay_assignments)\\M'),
         'other'
       ) AS waited_table,
       split_part(holder.application_name, '/', 2) AS holder_role,
       COUNT(*) AS waiters
FROM pg_stat_activity waiter
LEFT JOIN pg_stat_activity holder ON holder.pid = (pg_blocking_pids(waiter.pid))[1]
WHERE waiter.datname = current_database()
  AND waiter.wait_event_type = 'Lock'
  AND waiter.application_name LIKE 'orca-relay/%'
GROUP BY 1, 2, 3`

const RELAY_ROLES = new Set(['director', 'cell'])

export async function readPostgresLockWaitSample(
  database: RelayDatabase
): Promise<DatabaseLockWaitSample> {
  const rows = await database.query(LOCK_WAIT_SAMPLE_SQL)
  return rows.map((row) => ({
    waiterRole: relayRole(row['waiter_role']),
    table: String(row['waited_table']),
    holderRole: relayRole(row['holder_role']),
    waiters: Number(row['waiters'])
  }))
}

// Anything else (an operator session, a finished holder) stays one bounded key.
function relayRole(value: unknown): string {
  return typeof value === 'string' && RELAY_ROLES.has(value) ? value : 'other'
}
