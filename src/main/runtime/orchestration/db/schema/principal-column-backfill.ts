import type Database from '../../../../sqlite/sync-database'
import { principalFromPaneKey } from '../../../../../shared/orchestration-principal'

const PRINCIPAL_COLUMN_TUPLES = [
  { table: 'runs', paneColumn: 'coordinator_pane_key', principalColumn: 'coordinator_principal' },
  {
    table: 'dispatch_contexts',
    paneColumn: 'assignee_pane_key',
    principalColumn: 'assignee_principal'
  },
  {
    table: 'dispatch_contexts',
    paneColumn: 'creator_pane_key',
    principalColumn: 'creator_principal'
  },
  { table: 'worker_terminal_resources', paneColumn: 'pane_key', principalColumn: 'principal' }
] as const

/**
 * Reconciles principal columns from their pane-key columns — the v40 every-open pattern: a binary
 * rolled back past v41 keeps writing after user_version is already 41, inserting rows with NULL
 * principals and, worse, re-pointing pane keys without touching the principal, leaving stale
 * `pane:` values. Runs from migrate-v41 and from every open; idempotent by construction (a second
 * pass classifies to the same values and matches zero mismatches).
 *
 * The repair CLASSIFIES via principalFromPaneKey, never blindly copies, and rows whose principal
 * is `session:...` are fenced out entirely: a session row's pane columns hold the minted fake key
 * by design, so a copy-based reconcile would re-assert the wrong `pane:` value on every open.
 * Rows with a NULL pane key stay NULL — inventing a principal from a bare handle would mint
 * identity from a credential.
 */
export function backfillPrincipalColumns(db: Database.Database): void {
  for (const { table, paneColumn, principalColumn } of PRINCIPAL_COLUMN_TUPLES) {
    // Zero rows on a healthy database, so the steady-state open cost is four cheap scans.
    const candidates = db
      .prepare(
        `SELECT id, ${paneColumn} AS pane_key, ${principalColumn} AS principal FROM ${table}
         WHERE (${principalColumn} IS NULL AND ${paneColumn} IS NOT NULL)
            OR ${principalColumn} LIKE 'pane:%'`
      )
      .all() as { id: string; pane_key: string | null; principal: string | null }[]
    const repair = db.prepare(`UPDATE ${table} SET ${principalColumn} = ? WHERE id = ?`)
    for (const row of candidates) {
      const expected = principalFromPaneKey(row.pane_key)
      if (row.principal !== expected) {
        repair.run(expected, row.id)
      }
    }
  }
}
