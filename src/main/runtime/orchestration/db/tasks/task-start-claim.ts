import type { TaskRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import { taskNotStartableError } from '../../coordinator/dispatch/task-dispatch-refusal'
import {
  getLiveRemotePlacement,
  retireRemotePlacement
} from '../remote-owned/remote-placement-hold'

/**
 * The one claim every start of a Task passes, inside its caller's write transaction: a start here,
 * or a start placed on a paired server (`onServer`). While a start is being placed on a server, its
 * reservation is the Task's claim and every other start is refused.
 */
export function claimTaskForStart(
  db: OrchestrationDb,
  task: TaskRow,
  start: { retryOf?: string; onServer?: string }
): { priorFailures: number } {
  const placement = getLiveRemotePlacement(db, task.id)
  if (placement?.state === 'reserved') {
    throw taskNotStartableError(
      db,
      `Task ${task.id} is ${task.status}; only a ready Task can start.`,
      task
    )
  }
  if (start.onServer !== undefined) {
    // The server checks the rest of the retry chain on its own attempt; here it must be the Task's latest.
    if (
      start.retryOf !== undefined &&
      (placement?.environment_id !== start.onServer ||
        placement.dispatch_id !== start.retryOf ||
        !['failed', 'blocked'].includes(task.status))
    ) {
      throw taskNotStartableError(
        db,
        `Task ${task.id} cannot retry from Dispatch ${start.retryOf}.`,
        task,
        start.retryOf
      )
    }
    if (start.retryOf === undefined) {
      requireReadyTask(db, task)
    }
    return { priorFailures: 0 }
  }
  let priorFailures = 0
  if (start.retryOf) {
    const prior = db.getDispatchContextById(start.retryOf)
    const priorWorker = db.getWorkerDispatch(start.retryOf)
    const latest = db.getDispatchContext(task.id)
    if (prior?.task_id === task.id && prior.status === 'circuit_broken') {
      throw taskNotStartableError(
        db,
        `Task ${task.id} failed ${prior.failure_count} times, so Orca will not retry it again (last error: ${prior.last_failure ?? 'unknown'}). Report the failure to the user instead of retrying.`,
        task,
        start.retryOf,
        prior.failure_count
      )
    }
    // Context-only Dispatches have no worker row; read settlement from the Dispatch itself.
    const priorSettled = priorWorker
      ? ['failed', 'stopped', 'abandoned'].includes(priorWorker.state)
      : prior?.status === 'failed'
    if (
      !prior ||
      prior.task_id !== task.id ||
      latest?.id !== prior.id ||
      // A later attempt on a paired server, not the local one named, is the Task's latest.
      placement?.dispatch_id != null ||
      !priorSettled ||
      !['failed', 'blocked'].includes(task.status)
    ) {
      throw taskNotStartableError(
        db,
        `Task ${task.id} cannot retry from Dispatch ${start.retryOf}.`,
        task,
        start.retryOf
      )
    }
    // Only a retry chain inherits failures; a fresh start after a worker exit keeps its own count.
    priorFailures = prior.failure_count
  } else {
    requireReadyTask(db, task)
  }
  retireRemotePlacement(db, task.id)
  return { priorFailures }
}

function requireReadyTask(db: OrchestrationDb, task: TaskRow): void {
  if (task.status !== 'ready') {
    throw taskNotStartableError(
      db,
      `Task ${task.id} is ${task.status}; only a ready Task can start.`,
      task
    )
  }
}
