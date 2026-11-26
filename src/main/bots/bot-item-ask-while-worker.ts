// Whether the worker a `--while dispatch:` ask names still runs, from orchestration's durable rows (never
// the worker strip's view, which reads a lost terminal as stopped while its Dispatch is open). Workers
// on this computer only: a paired server's worker reads unknown, which never withdraws an ask.
import type { BotItemWorkerEnd } from '../../shared/bots/bot-item-ask-while'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchContextRow } from '../runtime/orchestration/db/orchestration-records'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../runtime/orchestration/db/row-column-lists'
import { getFollowUpDispatch } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { reportCorrectsUnobservedPrompt } from '../runtime/orchestration/workers/reports/worker-report-admission'

export type BotItemAskWhileWorker = 'running' | BotItemWorkerEnd | 'unknown'

const LINEAGE_MAX = 100
/** Worker states that may still end either way; orchestration recovers these. */
const OPEN_WORKER_STATES = new Set([
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown'
])

function retryOf(db: OrchestrationDb, row: DispatchContextRow): DispatchContextRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type.
  return db.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
        WHERE task_id = ? AND retry_of_dispatch_id = ? ORDER BY rowid DESC LIMIT 1`
    )
    .get(row.task_id, row.id) as DispatchContextRow | undefined
}

/** The attempt that speaks for the worker now: retries and follow-ups after `ref`, newest last. */
function newestAttempt(db: OrchestrationDb, ref: string): DispatchContextRow | undefined {
  let row = db.getDispatchContextById(ref)
  const seen = new Set<string>()
  while (row && !seen.has(row.id) && seen.size < LINEAGE_MAX) {
    seen.add(row.id)
    const next = retryOf(db, row) ?? getFollowUpDispatch(db, row.id)
    if (!next) {
      return row
    }
    row = next
  }
  return undefined
}

/** How the newest attempt stands. Anything a later report or recovery could still change reads
 *  `unknown`, as does anything unreadable. */
export function botItemAskWhileWorker(
  db: OrchestrationDb | null | undefined,
  ref: string
): BotItemAskWhileWorker {
  if (!db) {
    return 'unknown'
  }
  try {
    const row = newestAttempt(db, ref)
    if (!row) {
      return 'unknown'
    }
    if (row.status === 'pending' || row.status === 'dispatched') {
      return 'running'
    }
    if (row.status === 'completed') {
      return 'completed'
    }
    const task = db.getTask(row.task_id)
    if (!task || reportCorrectsUnobservedPrompt(row, task)) {
      return 'unknown'
    }
    const worker = db.getWorkerDispatch(row.id)
    if (worker && OPEN_WORKER_STATES.has(worker.state)) {
      return 'unknown'
    }
    return worker?.state === 'stopped' || row.last_failure === 'stopped' ? 'stopped' : 'failed'
  } catch (error) {
    console.warn('[bots] items: could not read a --while worker', error)
    return 'unknown'
  }
}
