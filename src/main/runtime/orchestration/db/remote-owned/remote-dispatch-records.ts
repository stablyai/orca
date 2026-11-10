import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { RemoteRunLinkRow } from './remote-run-links'
import { writtenRow } from './written-row'

export type RemoteDispatchRow = {
  dispatch_id: string
  conversation_id: string
  run_id: string
  environment_id: string
  task_id: string
  status: string
  worker_state: string | null
  last_failure: string | null
  agent: string | null
  last_report: string | null
  stop_owed: number
  stop_count: number
  stop_attempt: number
  stop_retries: number
  stop_retry_at: number | null
  stop_last_error: string | null
  created_at: string
  updated_at: string
}

const SETTLED_WORKER_STATES = ['succeeded', 'failed', 'stopped', 'abandoned']
const ACTIVE_DISPATCH_STATUSES = ['pending', 'dispatched']

/** Proof the server's worker is done: a settled worker, or a settled context-only Dispatch. */
export function isRemoteDispatchTerminal(
  record: Pick<RemoteDispatchRow, 'status' | 'worker_state'>
): boolean {
  return record.worker_state === null
    ? !ACTIVE_DISPATCH_STATUSES.includes(record.status)
    : SETTLED_WORKER_STATES.includes(record.worker_state)
}

/** Counted as a local Dispatch would be: active while its Dispatch is pending or dispatched there. */
export function isRemoteDispatchActive(record: Pick<RemoteDispatchRow, 'status'>): boolean {
  return ACTIVE_DISPATCH_STATUSES.includes(record.status)
}

export function getRemoteDispatch(
  db: OrchestrationDb,
  dispatchId: string
): RemoteDispatchRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db.prepare('SELECT * FROM remote_dispatches WHERE dispatch_id = ?').get(dispatchId) as
    | RemoteDispatchRow
    | undefined
}

export function listRemoteDispatches(db: OrchestrationDb, runId: string): RemoteDispatchRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare('SELECT * FROM remote_dispatches WHERE run_id = ? ORDER BY rowid')
    .all(runId) as RemoteDispatchRow[]
}

/** Identity only: which server runs the Dispatch and for which Task. State comes from the server's queue. */
export function ensureRemoteDispatchRecord(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  identity: { dispatchId: string; taskId: string; agent?: string | null }
): RemoteDispatchRow {
  db.db
    .prepare(
      `INSERT INTO remote_dispatches (dispatch_id, conversation_id, run_id, environment_id, task_id, agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET agent = COALESCE(remote_dispatches.agent, excluded.agent)`
    )
    .run(
      identity.dispatchId,
      link.conversation_id,
      link.run_id,
      link.environment_id,
      identity.taskId,
      identity.agent ?? null
    )
  return writtenRow(getRemoteDispatch(db, identity.dispatchId), `Dispatch ${identity.dispatchId}`)
}

/** The server's state for the Dispatch, applied in its queue order. A terminal state sends any stop owed at once: its receipt is now the proof. */
export function recordRemoteDispatchState(
  db: OrchestrationDb,
  dispatchId: string,
  state: Pick<RemoteDispatchRow, 'status' | 'worker_state' | 'last_failure' | 'agent'>
): RemoteDispatchRow {
  const terminal = isRemoteDispatchTerminal(state)
  db.db
    .prepare(
      `UPDATE remote_dispatches SET
         status = ?, worker_state = ?, last_failure = ?, agent = COALESCE(?, agent),
         stop_retry_at = CASE WHEN ? THEN NULL ELSE stop_retry_at END,
         updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      state.status,
      state.worker_state,
      state.last_failure,
      state.agent,
      terminal ? 1 : 0,
      dispatchId
    )
  return writtenRow(getRemoteDispatch(db, dispatchId), `Dispatch ${dispatchId}`)
}

export function recordRemoteDispatchReport(
  db: OrchestrationDb,
  dispatchId: string,
  report: string
): void {
  db.db
    .prepare(
      `UPDATE remote_dispatches SET last_report = ?, updated_at = datetime('now') WHERE dispatch_id = ?`
    )
    .run(report, dispatchId)
}

/**
 * One stop intent from this Orca: owed until the server's ordinary stop proves the worker and its
 * helpers stopped, even for a worker already finished, whose helpers may still run. A retry of an
 * intent keeps the count it was first given, so the server replays that stop instead of a new one.
 */
export function oweRemoteDispatchStop(
  db: OrchestrationDb,
  dispatchId: string,
  intentKey: string
): { record: RemoteDispatchRow; stopCount: number } | undefined {
  return runLifecycleWriteTransaction(db.db, 'owe_remote_dispatch_stop', () =>
    oweStopInTransaction(db, dispatchId, intentKey)
  )
}

function oweStopInTransaction(
  db: OrchestrationDb,
  dispatchId: string,
  intentKey: string
): { record: RemoteDispatchRow; stopCount: number } | undefined {
  const record = getRemoteDispatch(db, dispatchId)
  if (!record) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT over this table returns exactly these columns.
  const known = db.db
    .prepare('SELECT stop_count FROM remote_stop_intents WHERE dispatch_id = ? AND intent_key = ?')
    .get(dispatchId, intentKey) as { stop_count: number } | undefined
  if (known) {
    return { record, stopCount: known.stop_count }
  }
  db.db
    .prepare(
      `UPDATE remote_dispatches SET
         stop_owed = 1, stop_count = stop_count + 1, stop_attempt = 0,
         stop_retries = 0, stop_retry_at = NULL, stop_last_error = NULL, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(dispatchId)
  db.db
    .prepare(
      'INSERT INTO remote_stop_intents (dispatch_id, intent_key, stop_count) VALUES (?, ?, ?)'
    )
    .run(dispatchId, intentKey, record.stop_count + 1)
  return {
    record: writtenRow(getRemoteDispatch(db, dispatchId), `Dispatch ${dispatchId}`),
    stopCount: record.stop_count + 1
  }
}

/** The key one attempt at the owed stop goes out under; the server runs each distinct key once. */
export function remoteStopKey(
  record: Pick<RemoteDispatchRow, 'dispatch_id' | 'stop_count' | 'stop_attempt'>
): string {
  return `stop-${record.stop_count}.${record.stop_attempt}:${record.dispatch_id}`
}

export function listOwedRemoteStops(
  db: OrchestrationDb,
  environmentId: string,
  now: number
): RemoteDispatchRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare(
      `SELECT record.* FROM remote_dispatches record
       JOIN remote_run_links link
         ON link.conversation_id = record.conversation_id AND link.state = 'open'
       WHERE record.environment_id = ? AND record.stop_owed = 1
         AND (record.stop_retry_at IS NULL OR record.stop_retry_at <= ?)
       ORDER BY record.rowid`
    )
    .all(environmentId, now) as RemoteDispatchRow[]
}

/** The server no longer has the Dispatch at all; whatever stop was owed for it can never be proven. */
export function abandonRemoteDispatchStop(db: OrchestrationDb, dispatchId: string): void {
  db.db
    .prepare(
      `UPDATE remote_dispatches SET stop_owed = 0, stop_retry_at = NULL, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(dispatchId)
}

/** Clears the debt only for the count the proof answered; a newer intent since then stays owed. */
export function settleRemoteDispatchStop(
  db: OrchestrationDb,
  dispatchId: string,
  stopCount: number
): boolean {
  return (
    db.db
      .prepare(
        `UPDATE remote_dispatches SET stop_owed = 0, stop_retry_at = NULL, stop_last_error = NULL,
           updated_at = datetime('now')
         WHERE dispatch_id = ? AND stop_owed = 1 AND stop_count = ?`
      )
      .run(dispatchId, stopCount).changes === 1
  )
}

/** How long a resend waits after its `retries`-th unanswered or unproven try, doubling to a minute. */
export function remoteResendRetryAt(retries: number, now: number): number {
  return now + Math.min(2_000 * 2 ** Math.min(retries, 5), 60_000)
}

/**
 * The server answered without proof. The next attempt waits, then goes out under a new key so the
 * server's ordinary stop really runs again; a send that got no answer keeps its key.
 */
export function deferRemoteDispatchStop(
  db: OrchestrationDb,
  record: Pick<RemoteDispatchRow, 'dispatch_id' | 'stop_count' | 'stop_attempt'>,
  outcome: { answered: boolean; error: string; retryAt: number }
): void {
  db.db
    .prepare(
      `UPDATE remote_dispatches SET
         stop_attempt = CASE WHEN ? THEN stop_attempt + 1 ELSE stop_attempt END,
         stop_retries = stop_retries + 1, stop_retry_at = ?, stop_last_error = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND stop_owed = 1 AND stop_count = ? AND stop_attempt = ?`
    )
    .run(
      outcome.answered ? 1 : 0,
      outcome.retryAt,
      outcome.error,
      record.dispatch_id,
      record.stop_count,
      record.stop_attempt
    )
}
