import type { OrchestrationDb } from '../orchestration-db'
import { exposeUtcTimestamp } from '../utc-timestamp'

/** One row per Dispatch whose worker was observed: what it is doing now, and which of its rests the
 *  coordinator was told about. Created with the tables on open, so no version step is needed. */
export const WORKER_PRESENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_presence (
  dispatch_id          TEXT PRIMARY KEY,
  presence             TEXT NOT NULL CHECK(presence IN ('working', 'resting', 'prompt', 'gone')),
  generation           INTEGER NOT NULL,
  fence                TEXT,
  report               TEXT,
  reported_generation  INTEGER,
  reported_mail_count  INTEGER,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS worker_presence_undecided ON worker_presence(dispatch_id)
  WHERE report IS NOT NULL AND presence != 'working';
`

export type WorkerPresence = 'working' | 'resting' | 'prompt' | 'gone'

export type WorkerPresenceRow = {
  presence: WorkerPresence
  generation: number
  fence: string | null
  /** What to tell the coordinator about this rest, kept only until it is decided. */
  report: string | null
  reportedGeneration: number | null
  reportedMailCount: number | null
}

export function readWorkerPresence(
  db: OrchestrationDb,
  dispatchId: string
): WorkerPresenceRow | null {
  const row = db.db
    .prepare(
      `SELECT presence, generation, fence, report, reported_generation, reported_mail_count
         FROM worker_presence WHERE dispatch_id = ?`
    )
    .get(dispatchId)
  if (!row) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CHECK constraint bounds presence.
  const presence = row.presence as WorkerPresence
  const int = (value: unknown) => (typeof value === 'number' ? value : null)
  return {
    presence,
    generation: Number(row.generation),
    fence: typeof row.fence === 'string' ? row.fence : null,
    report: typeof row.report === 'string' ? row.report : null,
    reportedGeneration: int(row.reported_generation),
    reportedMailCount: int(row.reported_mail_count)
  }
}

/** The same presence under the same fence is the same fact, seen again: it keeps its generation. */
export function nextWorkerPresence(
  current: WorkerPresenceRow | null,
  next: { presence: WorkerPresence; fence: string | null; report: string | null }
): WorkerPresenceRow & { changed: boolean } {
  if (current && current.presence === next.presence && current.fence === next.fence) {
    return { ...current, changed: false }
  }
  return {
    ...next,
    generation: (current?.generation ?? 0) + 1,
    reportedGeneration: current?.reportedGeneration ?? null,
    reportedMailCount: current?.reportedMailCount ?? null,
    changed: true
  }
}

/** One write per change of presence or of what was reported. */
export function writeWorkerPresence(
  db: OrchestrationDb,
  dispatchId: string,
  row: WorkerPresenceRow
): void {
  db.db
    .prepare(
      `INSERT INTO worker_presence (
         dispatch_id, presence, generation, fence, report, reported_generation, reported_mail_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET
         presence = excluded.presence,
         generation = excluded.generation,
         fence = excluded.fence,
         report = excluded.report,
         reported_generation = excluded.reported_generation,
         reported_mail_count = excluded.reported_mail_count,
         updated_at = datetime('now')`
    )
    .run(
      dispatchId,
      row.presence,
      row.generation,
      row.fence,
      row.report,
      row.reportedGeneration,
      row.reportedMailCount
    )
}

/** The current rest is decided as no news: its report is dropped unsent. */
export function settleWorkerRestUnreported(db: OrchestrationDb, dispatchId: string): void {
  const row = readWorkerPresence(db, dispatchId)
  if (row?.report) {
    writeWorkerPresence(db, dispatchId, {
      ...row,
      report: null,
      reportedGeneration: row.generation
    })
  }
}

/** Dispatches whose worker rests, or went away, with a report still undecided. */
export function listUndecidedWorkerRests(db: OrchestrationDb): string[] {
  return db.db
    .prepare(
      `SELECT dispatch_id FROM worker_presence
        WHERE report IS NOT NULL AND presence != 'working'`
    )
    .all()
    .flatMap((row) => (typeof row.dispatch_id === 'string' ? [row.dispatch_id] : []))
}

/** A worker report this machine relayed toward its Run home under this id. */
export function hasRelayedWorkerReport(
  db: OrchestrationDb,
  dispatchId: string,
  messageId: string
): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM federation_relay_items
          WHERE dispatch_id = ? AND direction = 'to_home' AND message_id = ?`
      )
      .get(dispatchId, messageId) !== undefined
  )
}

/** Epoch ms when the worker entered its current `working` turn, if recorded. */
export function readWorkingTurnStartedAt(
  db: OrchestrationDb,
  dispatchId: string
): number | undefined {
  const row = db.db
    .prepare(
      `SELECT updated_at FROM worker_presence
        WHERE dispatch_id = ? AND presence = 'working'`
    )
    .get(dispatchId)
  const updatedAt = typeof row?.updated_at === 'string' ? exposeUtcTimestamp(row.updated_at) : null
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

export function readMaxMessageSequence(db: OrchestrationDb): number {
  const row = db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM messages').get()
  return typeof row?.seq === 'number' ? row.seq : 0
}

export function readMaxRelaySequence(db: OrchestrationDb, dispatchId: string): number {
  const row = db.db
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS seq FROM federation_relay_items
        WHERE dispatch_id = ? AND direction = 'to_home'`
    )
    .get(dispatchId)
  return typeof row?.seq === 'number' ? row.seq : 0
}

export function formatWorkingTurnFence(generation: number, afterSequence: number): string {
  return `turn:${generation}:seq:${afterSequence}`
}

/** Sequence watermark recorded when the worker entered its current `working` turn. */
export function readWorkingTurnAfterSequence(
  db: OrchestrationDb,
  dispatchId: string
): number | undefined {
  const row = db.db
    .prepare("SELECT fence FROM worker_presence WHERE dispatch_id = ? AND presence = 'working'")
    .get(dispatchId)
  const match = typeof row?.fence === 'string' ? /^turn:\d+:seq:(\d+)$/.exec(row.fence) : null
  return match ? Number(match[1]) : undefined
}
