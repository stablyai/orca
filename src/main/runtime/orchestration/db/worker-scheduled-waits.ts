import type { OrchestrationDb } from './orchestration-db'
import { SQLITE_UTC_TIMESTAMP_RE } from './utc-timestamp'

export const WORKER_SCHEDULED_WAITS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_scheduled_waits (
  dispatch_id TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  message_id TEXT NOT NULL,
  from_handle TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  owner_process TEXT,
  reported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_worker_scheduled_wait_deadline
  ON worker_scheduled_waits(until_ms) WHERE reported = 0;
`

export type WorkerScheduledWait = {
  dispatch_id: string
  until_ms: number
  reason: string
  message_id: string
  from_handle: string
  owner_generation: number
  owner_process: string | null
  reported: number
}

export function recordWorkerScheduledWait(
  db: OrchestrationDb,
  wait: {
    dispatchId: string
    until: string
    reason: string
    messageId: string
    from: string
  }
): void {
  const owner =
    db.getDispatchContextById(wait.dispatchId) ?? db.getRemoteDispatchAttachment(wait.dispatchId)
  if (!owner) {
    throw new Error('Cannot record a scheduled wait without a Dispatch owner.')
  }
  db.db
    .prepare(`INSERT INTO worker_scheduled_waits
    (dispatch_id, until_ms, reason, message_id, from_handle, owner_generation, owner_process)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dispatch_id) DO UPDATE SET until_ms = excluded.until_ms,
      reason = excluded.reason, message_id = excluded.message_id,
      from_handle = excluded.from_handle, owner_generation = excluded.owner_generation,
      owner_process = excluded.owner_process, reported = 0`)
    .run(
      wait.dispatchId,
      Date.parse(wait.until),
      wait.reason,
      wait.messageId,
      wait.from,
      owner.consumer_generation,
      owner.process_incarnation
    )
  db.workerScheduledWaitListener?.()
}

export function clearWorkerScheduledWait(db: OrchestrationDb, dispatchId: string): void {
  const result = db.db
    .prepare('DELETE FROM worker_scheduled_waits WHERE dispatch_id = ?')
    .run(dispatchId)
  if (result.changes) {
    db.workerScheduledWaitListener?.()
  }
}

export function clearWorkerScheduledWaitForPane(db: OrchestrationDb, paneKey: string): void {
  const id = activeScheduledWaitDispatchId(db, paneKey)
  if (id) {
    clearWorkerScheduledWait(db, id)
  }
}

/** A restored working projection is progress only when that turn started after the wait was recorded. */
export function clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
  db: OrchestrationDb,
  paneKey: string,
  turnStartedAtMs: number
): void {
  if (!Number.isFinite(turnStartedAtMs)) {
    return
  }
  const id = activeScheduledWaitDispatchId(db, paneKey)
  if (!id) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This SELECT returns the side table's message_id, or no row.
  const wait = db.db
    .prepare('SELECT message_id FROM worker_scheduled_waits WHERE dispatch_id = ?')
    .get(id) as { message_id: string } | undefined
  const recordedAt = wait ? scheduledWaitRecordedAt(db, id, wait.message_id) : undefined
  // datetime('now') is whole seconds; the same second is not a later turn.
  if (
    recordedAt === undefined ||
    Math.floor(turnStartedAtMs / 1000) <= Math.floor(recordedAt / 1000)
  ) {
    return
  }
  clearWorkerScheduledWait(db, id)
}

function activeScheduledWaitDispatchId(db: OrchestrationDb, paneKey: string): string | undefined {
  return (
    db.getActiveDispatchForTerminal('', paneKey)?.id ??
    db.findActiveRemoteAttachmentForPane(paneKey)?.dispatch_id
  )
}

function scheduledWaitRecordedAt(
  db: OrchestrationDb,
  dispatchId: string,
  messageId: string
): number | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This SELECT returns the messages.created_at column, or no row.
  const message = db.db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId) as
    | { created_at: string }
    | undefined
  // A remote wait's id is the relay item, not a local messages row.
  const relay = message
    ? undefined
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This SELECT returns the relay item's created_at, or no row.
      (db.db
        .prepare(
          `SELECT created_at FROM federation_relay_items
           WHERE dispatch_id = ? AND message_id = ?
           ORDER BY sequence LIMIT 1`
        )
        .get(dispatchId, messageId) as { created_at: string } | undefined)
  return sqliteUtcMs(message?.created_at ?? relay?.created_at)
}

function sqliteUtcMs(createdAt: string | undefined): number | undefined {
  if (!createdAt || !SQLITE_UTC_TIMESTAMP_RE.test(createdAt)) {
    return undefined
  }
  const ms = Date.parse(`${createdAt.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : undefined
}

export function clearWorkerScheduledWaitForMessages(db: OrchestrationDb, ids: string[]): void {
  if (ids.length === 0) {
    return
  }
  const placeholders = ids.map(() => '?').join(',')
  const result = db.db
    .prepare(`DELETE FROM worker_scheduled_waits WHERE dispatch_id IN (
    SELECT substr(to_handle, 10) FROM messages
    WHERE id IN (${placeholders}) AND to_handle LIKE 'dispatch:%'
      AND (read = 1 OR delivered_at IS NOT NULL)
  )`)
    .run(...ids)
  if (result.changes) {
    db.workerScheduledWaitListener?.()
  }
}

export function isWorkerScheduledWaitCurrent(
  db: OrchestrationDb,
  wait: WorkerScheduledWait
): boolean {
  const owner =
    db.getDispatchContextById(wait.dispatch_id) ?? db.getRemoteDispatchAttachment(wait.dispatch_id)
  return (
    !!owner &&
    owner.consumer_generation === wait.owner_generation &&
    owner.process_incarnation === wait.owner_process
  )
}

export function deferScheduledWorkerStop(db: OrchestrationDb, dispatchId: string): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This SELECT returns the side table schema declared above, or no row.
  const wait = db.db
    .prepare('SELECT * FROM worker_scheduled_waits WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerScheduledWait | undefined
  if (!wait) {
    return false
  }
  if (!isWorkerScheduledWaitCurrent(db, wait)) {
    clearWorkerScheduledWait(db, dispatchId)
    return false
  }
  // The deadline scheduler reports expiry once; later idle observations remain the same wait until progress clears it.
  return true
}

const workerScheduledWaitMethods = {
  nextWorkerScheduledWaitAtMs(this: OrchestrationDb): number | null {
    const value = this.db
      .prepare('SELECT MIN(until_ms) AS deadline FROM worker_scheduled_waits WHERE reported = 0')
      .get()?.deadline
    return typeof value === 'number' ? value : null
  },
  clearWorkerScheduledWaitForPane(this: OrchestrationDb, paneKey: string): void {
    clearWorkerScheduledWaitForPane(this, paneKey)
  },
  clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
    this: OrchestrationDb,
    paneKey: string,
    turnStartedAtMs: number
  ): void {
    clearWorkerScheduledWaitForPaneIfTurnStartedAfter(this, paneKey, turnStartedAtMs)
  }
}

export type WorkerScheduledWaitMethods = {
  nextWorkerScheduledWaitAtMs: () => number | null
  clearWorkerScheduledWaitForPane: (paneKey: string) => void
  clearWorkerScheduledWaitForPaneIfTurnStartedAfter: (
    paneKey: string,
    turnStartedAtMs: number
  ) => void
}

export function attachWorkerScheduledWaits(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, workerScheduledWaitMethods)
}
