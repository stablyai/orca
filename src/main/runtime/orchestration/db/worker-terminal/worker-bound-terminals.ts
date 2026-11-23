// Terminals that close with a worker: the setup terminal and startup tabs its start opened.
import type { OrchestrationDb } from '../orchestration-db'
import { isEquivalentPaneKey, paneKeyMatchSuffix } from '../pane-key-match'
import type { WorkerAutoCloseState } from '../../../../../shared/orchestration/workers/worker-auto-close'

export const WORKER_BOUND_TERMINAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_bound_terminals (
  terminal_handle TEXT PRIMARY KEY,
  -- The worker's first Dispatch: its terminal resource's origin_dispatch_id.
  dispatch_id     TEXT NOT NULL,
  pane_key        TEXT NOT NULL,
  -- setup or configured_tab; no CHECK, so later roles need no table rebuild.
  role            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worker_bound_terminals_dispatch
  ON worker_bound_terminals(dispatch_id);
`

export type WorkerBoundTerminalRole = 'setup' | 'configured_tab'

export type WorkerBoundTerminalRow = {
  terminal_handle: string
  dispatch_id: string
  pane_key: string
  role: WorkerBoundTerminalRole
}

export function bindWorkerTerminal(
  db: OrchestrationDb,
  row: {
    dispatchId: string
    terminalHandle: string
    paneKey: string
    role: WorkerBoundTerminalRole
  }
): void {
  db.db
    .prepare(
      `INSERT INTO worker_bound_terminals (terminal_handle, dispatch_id, pane_key, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(terminal_handle) DO UPDATE SET dispatch_id = excluded.dispatch_id,
         pane_key = excluded.pane_key, role = excluded.role`
    )
    .run(row.terminalHandle, row.dispatchId, row.paneKey, row.role)
}

export function listWorkerBoundTerminals(
  db: OrchestrationDb,
  dispatchId: string
): WorkerBoundTerminalRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection selects exactly the row type's columns.
  return db.db
    .prepare(
      `SELECT terminal_handle, dispatch_id, pane_key, role FROM worker_bound_terminals
        WHERE dispatch_id = ? ORDER BY created_at`
    )
    .all(dispatchId) as WorkerBoundTerminalRow[]
}

/** The binding of the pane shown, matching a reminted tab id by its leaf as worker resources do. */
export function findWorkerBoundTerminalByPane(
  db: OrchestrationDb,
  paneKey: string
): WorkerBoundTerminalRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection selects exactly the row type's columns.
  const candidates = db.db
    .prepare(
      `SELECT terminal_handle, dispatch_id, pane_key, role FROM worker_bound_terminals
        WHERE pane_key = ? OR substr(pane_key, instr(pane_key, ':') + 1) = ?`
    )
    .all(paneKey, paneKeyMatchSuffix(paneKey)) as WorkerBoundTerminalRow[]
  return (
    candidates.find((row) => row.pane_key === paneKey) ??
    candidates.find((row) => isEquivalentPaneKey(row.pane_key, paneKey))
  )
}

/** Whether this call removed the binding: false once Keep open or another close already did. */
export function unbindWorkerTerminal(db: OrchestrationDb, terminalHandle: string): boolean {
  return (
    db.db
      .prepare('DELETE FROM worker_bound_terminals WHERE terminal_handle = ?')
      .run(terminalHandle).changes > 0
  )
}

/** A shown pane's auto-close state: its own worker's, else the worker it is bound to (it closes with
 *  that worker), else null. */
export function paneAutoCloseState(
  db: OrchestrationDb,
  paneKey: string
): WorkerAutoCloseState | null {
  const own = db.getWorkerAutoCloseState(paneKey)
  const bound = own ? undefined : findWorkerBoundTerminalByPane(db, paneKey)
  if (!bound) {
    return own
  }
  // A failed setup stays open after its worker closes, so it shows no countdown.
  if (isFailedSetupBinding(db, bound)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection selects exactly pane_key.
  const worker = db.db
    .prepare(
      `SELECT pane_key FROM worker_terminal_resources
        WHERE origin_dispatch_id = ? AND pane_key IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
    )
    .get(bound.dispatch_id) as { pane_key: string } | undefined
  return worker ? db.getWorkerAutoCloseState(worker.pane_key) : null
}

/** Keep open on a pane: its own worker keeps everything; a bound pane leaves its worker and stays. */
export function keepPaneOpen(db: OrchestrationDb, paneKey: string): void {
  if (db.keepWorkerTerminalOpen(paneKey) > 0 || db.getWorkerAutoCloseState(paneKey)) {
    return
  }
  const bound = findWorkerBoundTerminalByPane(db, paneKey)
  if (bound) {
    unbindWorkerTerminal(db, bound.terminal_handle)
  }
}

const FAILED_SETUP_STATES = new Set(['failed', 'spawn_failed'])

/** A setup terminal whose setup failed: it outlives its worker, to show the error. */
export function isFailedSetupBinding(db: OrchestrationDb, bound: WorkerBoundTerminalRow): boolean {
  return (
    bound.role === 'setup' &&
    FAILED_SETUP_STATES.has(db.getWorkerDispatch(bound.dispatch_id)?.setup_state ?? '')
  )
}
