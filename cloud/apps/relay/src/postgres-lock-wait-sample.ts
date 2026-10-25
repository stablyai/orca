import type { RelayDatabase } from './database.js'
import type { DatabaseLockWaitSample } from './relay-observability.js'

// Every relay process connects as the same user through a socket, so neither
// pg_stat_statements nor Query Insights can tell a director's lock wait from a
// cell's. application_name (`orca-relay/<role>/<cell>`) can, so this samples it.
// The holder is the root of the wait chain: in a row-lock convoy every later
// waiter is blocked by the first waiter, not by the transaction holding the row.
// Blockers are read once per waiter; non-relay waiters stay in so chains through
// them resolve, and the depth cap bounds a cycle. The table is the first relay
// table the waiting statement names, which may be one it only references.
// It shares the director's 3-slot pool, so when every slot is a lock waiter the
// sample queues and undercounts director waiters; a dedicated connection fixes that.
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
