// Whether the worker a `--while dispatch:` ask names still runs, from orchestration's durable Dispatch rows
// (never the worker strip's view, which reads a lost terminal as stopped while its Dispatch is open).
import type { BotItemWorkerEnd } from '../../shared/bots/bot-item-ask-while'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { getFollowUpDispatch } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { getActiveDispatchForTask } from '../runtime/orchestration/db/dispatch-context/task-dispatch-reconciliation'

export type BotItemAskWhileWorker = 'running' | BotItemWorkerEnd | 'unknown'

const LINEAGE_MAX = 100

/** The newest step of the ref's follow-up chain decides; a retry of its Task, or a step still open,
 *  is still running. Anything unreadable is `unknown`, which never withdraws an ask. */
export function botItemAskWhileWorker(
  db: OrchestrationDb | null | undefined,
  ref: string
): BotItemAskWhileWorker {
  if (!db) {
    return 'unknown'
  }
  try {
    let row = db.getDispatchContextById(ref)
    if (!row) {
      return 'unknown'
    }
    const seen = new Set([row.id])
    for (
      let next = getFollowUpDispatch(db, row.id);
      next && !seen.has(next.id) && seen.size < LINEAGE_MAX;
      next = getFollowUpDispatch(db, next.id)
    ) {
      seen.add(next.id)
      row = next
    }
    if (row.status === 'pending' || row.status === 'dispatched') {
      return 'running'
    }
    if (getActiveDispatchForTask(db, row.task_id)) {
      return 'running'
    }
    if (row.status === 'completed') {
      return 'completed'
    }
    return row.termination_reason === 'operator_close' ? 'stopped' : 'failed'
  } catch (error) {
    console.warn('[bots] items: could not read a --while worker', error)
    return 'unknown'
  }
}
