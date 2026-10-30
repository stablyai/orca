import type { RelayDatabase } from './database.js'
import type { DatabaseLockWaitSample } from './relay-observability.js'

// Use application_name (orca-relay/<role>/<cell>) to separate shared-user waiters. Follow blockers to root, keeping non-relay intermediates and bounding depth for cycles. First referenced relay table labels the wait. Shared 3-slot pool can queue/undercount samples when saturated; dedicated sampling avoids it.
const LOCK_WAIT_SAMPLE_SQL = `
WITH RECURSIVE waiting AS MATERIALIZED (
  SELECT pid, application_name, query, (pg_blocking_pids(pid))[1] AS blocker
  FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock'
), chain AS (
  SELECT pid AS waiter, blocker AS pid, 1 AS depth FROM waiting
  UNION ALL
  SELECT chain.waiter, waiting.blocker, chain.depth + 1
  FROM chain JOIN waiting ON waiting.pid = chain.pid
  WHERE chain.depth < 8
), root AS (
  SELECT DISTINCT ON (waiter) waiter, pid FROM chain ORDER BY waiter, depth DESC
)
SELECT split_part(w.application_name, '/', 2) AS waiter_role,
       COALESCE(
         substring(w.query FROM '\\m(relay_cells|relay_assignments)\\M'),
         'other'
       ) AS waited_table,
       split_part(holder.application_name, '/', 2) AS holder_role,
       COUNT(*) AS waiters
FROM waiting w JOIN root ON root.waiter = w.pid
LEFT JOIN pg_stat_activity holder ON holder.pid = root.pid
WHERE w.application_name LIKE 'orca-relay/%'
GROUP BY 1, 2, 3`

const RELAY_ROLES = new Set(['director', 'cell', 'combined'])

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
