import type Database from '../../../../sqlite/sync-database'
import type { SqliteRow } from '../../../../sqlite/sqlite-statement'
import {
  REMOVED_WORK_PAGE_SIZE,
  RemovedWorkEntrySchema,
  type RemovedWorkEntry,
  type ResetRemovedWork,
  type RunRemovedWork
} from '../../../../../shared/orchestration-removed-work'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../federation/remote-attachment-liveness'
import { DURABLE_EXIT_PROOF } from '../../../../../shared/orchestration-fleet-worker-projection'
import { OrchestrationError } from '../../orchestration-error'
import { exposeUtcTimestamp } from '../utc-timestamp'

const WORKER_KINDS = "('worker', 'remote_worker', 'federated_worker')"
const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ')
const field = (key: string): string => `json_extract(record, '$.${key}')`
// Every json_extract sits behind json_valid: a bad record must never fail the read.
const whenValid = (predicate: string): string =>
  `CASE WHEN json_valid(record) THEN ${predicate} ELSE 0 END`

// Held: Orca was still supervising the process when tracking stopped, not a verdict about now.
const HELD_WORKER_ROW_SQL = whenValid(`(kind IN ('worker', 'remote_worker')
  AND ${field('state')} IN (${sqlList(POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES)}))
  OR (kind = 'federated_worker' AND ${field('dispatchStatus')} IN ('pending', 'dispatched'))`)
// A settled worker keeps its agent open in a terminal Orca still owns.
const HELD_TERMINAL_ROW_SQL = `kind = 'terminal' AND ${whenValid(
  `COALESCE(${field('ownershipState')}, '') NOT IN ('user_owned', 'released')`
)}`
// Proven ended: the same durable exit proof the fleet liveness verdict accepts.
const ENDED_WORKER_ROW_SQL = `kind IN ('worker', 'remote_worker') AND ${whenValid(
  `${field('state')} = '${DURABLE_EXIT_PROOF.workerState}' OR ${field('stage')} = '${DURABLE_EXIT_PROOF.workerStage}'`
)}`
const RELEASED_TERMINAL_ROW_SQL = `kind = 'terminal' AND ${whenValid(
  `${field('releaseState')} = '${DURABLE_EXIT_PROOF.resourceReleaseState}'`
)}`
const ENDED_DISPATCH_ROW_SQL = `kind = 'dispatch' AND ${whenValid(
  `${field('terminationReason')} IN (${sqlList(DURABLE_EXIT_PROOF.terminationReasons)})`
)}`

/** Removed rows matching `scopeSql`, their distinct workers, and the workers that may still run. */
function removedWorkScopeSql(scopeSql: string): string {
  return `WITH scope AS (
      SELECT run_id, kind, entity_id, record FROM removed_orchestration_work WHERE ${scopeSql}
    ),
    workers AS (SELECT DISTINCT entity_id AS id FROM scope WHERE kind IN ${WORKER_KINDS}),
    held AS (
      SELECT entity_id AS id FROM scope WHERE ${HELD_WORKER_ROW_SQL}
      UNION SELECT ${field('ownerDispatchId')} FROM scope WHERE ${HELD_TERMINAL_ROW_SQL}
    ),
    ended AS (
      SELECT entity_id AS id FROM scope WHERE ${ENDED_WORKER_ROW_SQL}
      UNION SELECT ${field('ownerDispatchId')} FROM scope WHERE ${RELEASED_TERMINAL_ROW_SQL}
      UNION SELECT entity_id FROM scope WHERE ${ENDED_DISPATCH_ROW_SQL}
    ),
    active AS (SELECT id FROM held WHERE id IN (SELECT id FROM workers) EXCEPT SELECT id FROM ended)`
}

function readRemovedWorkCounts(db: Database.Database, scopeSql: string, param: string | number) {
  const row = db
    .prepare(
      `${removedWorkScopeSql(scopeSql)}
      SELECT json_group_array(DISTINCT run_id) AS run_ids,
        COALESCE(SUM(kind = 'task'), 0) AS tasks,
        COALESCE(SUM(kind = 'dispatch'), 0) AS dispatches,
        COALESCE(SUM(kind = 'terminal'), 0) AS terminals,
        (SELECT COUNT(*) FROM workers) AS workers,
        (SELECT COUNT(*) FROM active) AS active
      FROM scope`
    )
    .get(param)
  const runIds: unknown = JSON.parse(String(row?.run_ids ?? '[]'))
  return {
    runIds: Array.isArray(runIds) ? runIds.filter((id) => typeof id === 'string') : [],
    tasks: Number(row?.tasks ?? 0),
    dispatches: Number(row?.dispatches ?? 0),
    terminals: Number(row?.terminals ?? 0),
    workers: Number(row?.workers ?? 0),
    active: Number(row?.active ?? 0)
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Read inside the reset transaction, so the summary covers exactly that reset's removals. */
export function readRemovedWorkWatermark(db: Database.Database): number {
  return Number(
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM removed_orchestration_work').get()?.seq
  )
}

/** Never throws: the reset already committed, and its reply only loses this optional field. */
export function summarizeRemovedWorkSince(
  db: Database.Database,
  watermark: number
): ResetRemovedWork | undefined {
  try {
    const counts = readRemovedWorkCounts(db, 'seq > ?', watermark)
    return {
      runs: counts.runIds.length,
      runIds: counts.runIds,
      tasks: counts.tasks,
      dispatches: counts.dispatches,
      workers: counts.workers,
      possiblyRunning: counts.active
    }
  } catch (error) {
    console.warn('[orchestration] Could not summarize removed work after reset', error)
    return undefined
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeEntry(row: SqliteRow, activeIds: ReadonlySet<string>): RemovedWorkEntry {
  const base = {
    seq: Number(row.seq),
    id: String(row.entity_id),
    removedAt: exposeUtcTimestamp(text(row.removed_at)) ?? ''
  }
  const kind = String(row.kind)
  const record = parseRecord(row.record)
  // Non-worker kinds strip activeAtRemoval; an unknown kind or bad record reads as unreadable.
  const parsed = RemovedWorkEntrySchema.safeParse({
    ...record,
    ...base,
    kind,
    createdAt: exposeUtcTimestamp(text(record?.createdAt)),
    activeAtRemoval: activeIds.has(base.id)
  })
  return record && parsed.success ? parsed.data : { ...base, kind, unreadable: true }
}

/** Never throws for bookkeeping reasons: on a failed read run-show simply omits the field. */
export function readRunRemovedWork(
  db: Database.Database,
  runId: string,
  options: { removed?: boolean | undefined; cursor?: string | undefined }
): RunRemovedWork | undefined {
  if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) {
    throw new OrchestrationError('cursor_invalid', 'The removed work cursor is invalid.')
  }
  try {
    return readRunRemovedWorkPage(db, runId, options)
  } catch (error) {
    console.warn('[orchestration] Could not read removed work for run-show', error)
    return undefined
  }
}

function readRunRemovedWorkPage(
  db: Database.Database,
  runId: string,
  options: { removed?: boolean | undefined; cursor?: string | undefined }
): RunRemovedWork | undefined {
  // A moved marker sorts after every non-legacy Run that existed then (the empty legacy Run is
  // excluded on purpose; see the capture install), so >= is exact.
  const coverage = db
    .prepare(
      `SELECT recorded_since,
         (SELECT created_at FROM runs WHERE id = ?) >= recorded_since AS complete,
         (SELECT MAX(removed_at) FROM removed_orchestration_work WHERE run_id = ?) AS last_removed_at
       FROM removed_orchestration_work_coverage`
    )
    .get(runId, runId)
  if (!coverage) {
    return undefined
  }
  const counts = readRemovedWorkCounts(db, 'run_id = ?', runId)
  const summary: RunRemovedWork = {
    coverage: coverage.complete === 1 ? 'complete' : 'partial',
    recordedSince: exposeUtcTimestamp(text(coverage.recorded_since)) ?? '',
    tasks: counts.tasks,
    dispatches: counts.dispatches,
    workers: counts.workers,
    terminals: counts.terminals,
    activeWorkersAtRemoval: counts.active,
    lastRemovedAt: exposeUtcTimestamp(text(coverage.last_removed_at))
  }
  if (!options.removed && options.cursor === undefined) {
    return summary
  }
  const activeIds = new Set(
    db
      .prepare(
        `${removedWorkScopeSql('run_id = ?')}
        SELECT id FROM active`
      )
      .all(runId)
      .map((row) => String(row.id))
  )
  // A federated worker also has a local worker row; list it once, as the counts do.
  const rows = db
    .prepare(
      `SELECT seq, kind, entity_id, record, removed_at FROM removed_orchestration_work removed
       WHERE run_id = ? AND seq > ?
         AND NOT (kind = 'worker' AND EXISTS (
           SELECT 1 FROM removed_orchestration_work federated
           WHERE federated.entity_id = removed.entity_id AND federated.kind = 'federated_worker'
             AND federated.run_id = removed.run_id))
       ORDER BY seq LIMIT ?`
    )
    .all(runId, Number(options.cursor ?? 0), REMOVED_WORK_PAGE_SIZE + 1)
  const entries = rows.slice(0, REMOVED_WORK_PAGE_SIZE).map((row) => decodeEntry(row, activeIds))
  const hasMore = rows.length > REMOVED_WORK_PAGE_SIZE
  return {
    ...summary,
    entries,
    page: { hasMore, nextCursor: hasMore ? String(entries.at(-1)?.seq) : null }
  }
}
