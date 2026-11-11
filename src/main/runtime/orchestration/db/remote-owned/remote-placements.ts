import type { TaskRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { taskNotFoundError } from '../../coordinator/dispatch/task-dispatch-refusal'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'
import {
  getActiveDispatchForTask,
  reconcileTaskAfterDispatchInterruption
} from '../dispatch-context/task-dispatch-reconciliation'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { claimTaskForStart } from '../tasks/task-start-claim'
import {
  ABANDONED_HERE,
  ensureRemoteDispatchRecord,
  getRemoteDispatch,
  isRemoteDispatchActive,
  isRemoteDispatchTerminal,
  type RemoteDispatchRow
} from './remote-dispatch-records'
import { getOpenRemoteRunLink, type RemoteRunLinkRow } from './remote-run-links'
import {
  getLiveRemotePlacement,
  refuseTaskOfClosedPairing,
  type RemotePlacementRow
} from './remote-placement-hold'
import { writtenRow } from './written-row'

export type { RemotePlacementRow }

export function getRemotePlacement(
  db: OrchestrationDb,
  taskId: string
): RemotePlacementRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db.prepare('SELECT * FROM remote_placements WHERE task_id = ?').get(taskId) as
    | RemotePlacementRow
    | undefined
}

type TaskCreation = Omit<Parameters<OrchestrationDb['createTask']>[0], 'id' | 'runId'>

/**
 * Claims the Task for a start on the link's server before the start is sent: the Task is
 * dispatched here and fenced from every other start until the server answers. A same-key retry
 * finds its own reservation. Creates the Task (under its adopted ID) when `create` is given.
 */
export function reserveRemotePlacement(
  db: OrchestrationDb,
  params: {
    link: RemoteRunLinkRow
    taskId: string
    requestKey: string
    /** The server as this Orca names it, for the refusal of a Task an earlier pairing placed there. */
    serverName?: string
    create?: TaskCreation
    retryOf?: string
  }
): { placement: RemotePlacementRow; task: TaskRow } {
  const transaction = beginLifecycleWriteTransaction(db.db, 'reserve_remote_placement')
  try {
    const link = getOpenRemoteRunLink(db, params.link.conversation_id)
    if (!link) {
      throw new OrchestrationError(
        'run_not_found',
        `Run ${params.link.run_id} was reset while this start was waiting. No effects were applied.`,
        { effectsApplied: false }
      )
    }
    const existing = getRemotePlacement(db, params.taskId)
    // Only this link's own reservation answers a retry; one under a link a re-pair closed holds nothing.
    if (
      existing?.request_key === params.requestKey &&
      existing.conversation_id === link.conversation_id
    ) {
      commitLifecycleWriteTransaction(db.db, transaction)
      return {
        placement: existing,
        task: writtenRow(db.getTask(params.taskId), `Task ${params.taskId}`)
      }
    }
    const task =
      db.getTask(params.taskId) ??
      (params.create
        ? db.createTask({ ...params.create, id: params.taskId, runId: link.run_id })
        : undefined)
    if (!task || task.run_id !== link.run_id) {
      throw taskNotFoundError(`Task ${params.taskId} was not found in Run ${link.run_id}.`, {
        taskId: params.taskId,
        runId: link.run_id
      })
    }
    refuseTaskOfClosedPairing(db, task.id, link, params.serverName ?? link.environment_id)
    claimTaskForStart(db, task, { retryOf: params.retryOf, onServer: link.environment_id })
    db.db
      .prepare(
        `INSERT INTO remote_placements (
           task_id, run_id, environment_id, conversation_id, state, request_key, prior_task_status,
           dispatch_id
         ) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           run_id = excluded.run_id, environment_id = excluded.environment_id,
           conversation_id = excluded.conversation_id, state = 'reserved',
           request_key = excluded.request_key, prior_task_status = excluded.prior_task_status,
           dispatch_id = excluded.dispatch_id`
      )
      .run(
        task.id,
        link.run_id,
        link.environment_id,
        link.conversation_id,
        params.requestKey,
        task.status,
        params.retryOf ?? null
      )
    transitionLifecycleWithDb(db.db, {
      entity: 'task',
      id: task.id,
      from: task.status,
      to: 'dispatched',
      projection: { result: null, completed_at: null }
    })
    commitLifecycleWriteTransaction(db.db, transaction)
    return {
      placement: writtenRow(getRemotePlacement(db, task.id), `Placement of ${task.id}`),
      task: writtenRow(db.getTask(task.id), `Task ${task.id}`)
    }
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
  }
}

/**
 * The server said the start applied nothing, so the Task goes back to where it was and is free to
 * start again. A Task the start itself created ends failed, as a local start that fails after
 * creating its Task leaves it: others may already depend on it.
 */
export function releaseRemotePlacement(
  db: OrchestrationDb,
  taskId: string,
  requestKey: string,
  { createdByStart = false }: { createdByStart?: boolean } = {}
): void {
  const transaction = beginLifecycleWriteTransaction(db.db, 'release_remote_placement')
  try {
    const placement = getRemotePlacement(db, taskId)
    if (placement?.state === 'reserved' && placement.request_key === requestKey) {
      // A refused retry leaves the attempt it retried as the Task's current one.
      if (placement.dispatch_id) {
        db.db
          .prepare(`UPDATE remote_placements SET state = 'accepted' WHERE task_id = ?`)
          .run(taskId)
      } else {
        db.db.prepare('DELETE FROM remote_placements WHERE task_id = ?').run(taskId)
      }
      const task = db.getTask(taskId)
      if (task?.status === 'dispatched') {
        const failed = createdByStart
        transitionLifecycleWithDb(db.db, {
          entity: 'task',
          id: taskId,
          from: 'dispatched',
          to: failed ? 'failed' : placement.prior_task_status,
          ...(failed ? { projection: { completed_at: new Date().toISOString() } } : {})
        })
      }
    }
    commitLifecycleWriteTransaction(db.db, transaction)
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
  }
}

/**
 * The server confirmed it runs `dispatchId` for the Task (launch, then record). Recorded only while
 * the link is still open and the Task is still placed there, so a late answer after a reset records
 * nothing. Identity only; the Dispatch's state comes from the server's queue.
 */
export function recordRemoteStart(
  db: OrchestrationDb,
  params: {
    conversationId: string
    taskId: string
    dispatchId: string
    requestKey: string
    peerRunId?: string
    agent?: string | null
  }
): RemoteDispatchRow | undefined {
  const transaction = beginLifecycleWriteTransaction(db.db, 'record_remote_start')
  try {
    const link = getOpenRemoteRunLink(db, params.conversationId)
    const placement = getRemotePlacement(db, params.taskId)
    const ours =
      placement?.conversation_id === params.conversationId &&
      (placement.request_key === params.requestKey || placement.dispatch_id === params.dispatchId)
    const record =
      link && ours
        ? adoptRemoteAttempt(db, link, {
            taskId: params.taskId,
            dispatchId: params.dispatchId,
            agent: params.agent
          })
        : undefined
    if (record && params.peerRunId) {
      noteRemoteRunLinkPeerRun(db, params.conversationId, params.peerRunId)
    }
    commitLifecycleWriteTransaction(db.db, transaction)
    return record
  } catch (error) {
    rollbackLifecycleWriteTransaction(db.db, transaction)
    throw error
  }
}

/**
 * A Dispatch the server started for a Task placed through this link becomes the Task's current
 * attempt. Called inside its caller's transaction, after the caller re-read the link as open.
 */
export function adoptRemoteAttempt(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  attempt: { taskId: string; dispatchId: string; agent?: string | null }
): RemoteDispatchRow {
  const known = getRemoteDispatch(db, attempt.dispatchId)
  const record = ensureRemoteDispatchRecord(db, link, attempt)
  const placement = getRemotePlacement(db, attempt.taskId)
  if (
    placement?.conversation_id !== link.conversation_id ||
    placement.dispatch_id === record.dispatch_id
  ) {
    return record
  }
  if (known) {
    // A Dispatch this Orca already knew predates the placement's attempt or reservation; only a new one is its answer.
    return record
  }
  db.db
    .prepare(`UPDATE remote_placements SET state = 'accepted', dispatch_id = ? WHERE task_id = ?`)
    .run(record.dispatch_id, attempt.taskId)
  const task = db.getTask(attempt.taskId)
  // A retry the server started reopens the Task here, as a local retry's claim does.
  if (task && task.status !== 'dispatched' && isRemoteDispatchActive(record)) {
    transitionLifecycleWithDb(db.db, {
      entity: 'task',
      id: task.id,
      from: task.status,
      to: 'dispatched',
      projection: { result: null, completed_at: null }
    })
  }
  return record
}

export function noteRemoteRunLinkPeerRun(
  db: OrchestrationDb,
  conversationId: string,
  peerRunId: string
): void {
  db.db
    .prepare(
      `UPDATE remote_run_links SET peer_run_id = ? WHERE conversation_id = ? AND peer_run_id IS NULL`
    )
    .run(peerRunId, conversationId)
}

/**
 * The attempt whose result the Task takes: the Dispatch its placement holds, unless the Task has
 * since been started here, where a local Dispatch speaks for it.
 */
export function currentRemoteAttempt(
  db: OrchestrationDb,
  taskId: string
): RemoteDispatchRow | undefined {
  const placement = getLiveRemotePlacement(db, taskId)
  if (placement?.state !== 'accepted' || !placement.dispatch_id) {
    return undefined
  }
  if (getActiveDispatchForTask(db, taskId)) {
    return undefined
  }
  return getRemoteDispatch(db, placement.dispatch_id)
}

/**
 * How a Task's placement on a server holds it, for the guards a local Dispatch would trip: a
 * reservation holds it as a starting worker; an accepted attempt as its Dispatch and worker do.
 */
export function remoteHoldOnTask(
  db: OrchestrationDb,
  taskId: string
): { dispatchId: string | null; active: boolean; liveWorker: boolean } | undefined {
  const placement = getLiveRemotePlacement(db, taskId)
  if (!placement) {
    return undefined
  }
  if (placement.state === 'reserved') {
    return { dispatchId: placement.dispatch_id, active: true, liveWorker: true }
  }
  const attempt = currentRemoteAttempt(db, taskId)
  if (!attempt || attempt.task_settled_here) {
    return undefined
  }
  // The server owns the Task until its result has come home: a finished worker whose Task here is
  // still dispatched holds it just as a running one does.
  const held = !isRemoteDispatchTerminal(attempt) || db.getTask(taskId)?.status === 'dispatched'
  return held ? { dispatchId: attempt.dispatch_id, active: true, liveWorker: true } : undefined
}

/**
 * A stop or abandon the server did not answer: the Task half runs here at once, as a local stop's
 * does (blocked, so it can be retried), while the stop stays owed. The first result stands, so a
 * later state from the server changes only this attempt's record.
 */
export function settleRemoteAttemptHere(
  db: OrchestrationDb,
  dispatchId: string,
  how: 'stopped' | 'abandoned'
): void {
  runLifecycleWriteTransaction(db.db, 'settle_remote_attempt_here', () => {
    const record = getRemoteDispatch(db, dispatchId)
    if (!record) {
      return
    }
    if (how === 'abandoned') {
      db.db
        .prepare('UPDATE remote_dispatches SET task_settled_here = ? WHERE dispatch_id = ?')
        .run(ABANDONED_HERE, dispatchId)
    }
    if (record.task_settled_here) {
      return
    }
    const current = currentRemoteAttempt(db, record.task_id)?.dispatch_id === dispatchId
    if (how === 'stopped') {
      db.db
        .prepare('UPDATE remote_dispatches SET task_settled_here = 1 WHERE dispatch_id = ?')
        .run(dispatchId)
    }
    if (current) {
      reconcileTaskAfterDispatchInterruption(db, record.task_id, dispatchId)
    }
  })
}
