// Whether the worker a `--while dispatch:` ask names still runs, from orchestration's durable rows (never
// the worker strip's view, which reads a lost terminal as stopped while its Dispatch is open). Workers
// on this computer only: a paired server's worker reads unknown, which never withdraws an ask.
import type { BotItemWorkerEnd } from '../../shared/bots/bot-item-ask-while'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchContextRow } from '../runtime/orchestration/db/orchestration-records'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../runtime/orchestration/db/row-column-lists'
import { getFollowUpDispatch } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { getActiveDispatchForTask } from '../runtime/orchestration/db/dispatch-context/task-dispatch-reconciliation'
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

type Attempt = DispatchContextRow & { at: number }

function attemptOf(row: unknown): Attempt | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type, plus its rowid as `at`.
  return row as Attempt | undefined
}

function attempt(db: OrchestrationDb, id: string): Attempt | undefined {
  return attemptOf(
    db.db
      .prepare(
        `SELECT rowid AS at, ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE id = ?`
      )
      .get(id)
  )
}

/** The Task's next attempt after this one (a retry, or a fresh start after recovery readied it), so
 *  every attempt is visited and each one's follow-up read. */
function laterAttempt(db: OrchestrationDb, row: Attempt): Attempt | undefined {
  return attemptOf(
    db.db
      .prepare(
        `SELECT rowid AS at, ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
          WHERE task_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 1`
      )
      .get(row.task_id, row.at)
  )
}

/** How one attempt with nothing after it ended; `unknown` while a report or recovery could change it. */
function endOf(db: OrchestrationDb, row: DispatchContextRow): BotItemAskWhileWorker {
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
  return worker?.state === 'stopped' ||
    row.last_failure === 'stopped' ||
    row.termination_reason === 'operator_close'
    ? 'stopped'
    : 'failed'
}

/** Every branch after `ref` (later attempts on its Task, follow-ups): running while any is, unknown
 *  while any can't be told, else how the newest one ended. */
export function botItemAskWhileWorker(
  db: OrchestrationDb | null | undefined,
  ref: string
): BotItemAskWhileWorker {
  if (!db) {
    return 'unknown'
  }
  try {
    const root = attempt(db, ref)
    if (!root) {
      return 'unknown'
    }
    const seen = new Set<string>()
    const ends: { row: Attempt; end: BotItemAskWhileWorker }[] = []
    const stack = [root]
    for (let row = stack.pop(); row; row = stack.pop()) {
      if (seen.has(row.id)) {
        continue
      }
      seen.add(row.id)
      if (seen.size > LINEAGE_MAX) {
        return 'unknown'
      }
      if (
        row.status === 'pending' ||
        row.status === 'dispatched' ||
        getActiveDispatchForTask(db, row.task_id)
      ) {
        return 'running'
      }
      const followUp = getFollowUpDispatch(db, row.id)
      const next = [laterAttempt(db, row), followUp && attempt(db, followUp.id)].filter(
        (entry): entry is Attempt => entry !== undefined
      )
      if (next.length === 0) {
        ends.push({ row, end: endOf(db, row) })
      }
      stack.push(...next)
    }
    if (ends.length === 0 || ends.some(({ end }) => end === 'unknown')) {
      return 'unknown'
    }
    return ends.reduce((a, b) => (b.row.at > a.row.at ? b : a)).end
  } catch (error) {
    console.warn('[bots] items: could not read a --while worker', error)
    return 'unknown'
  }
}
