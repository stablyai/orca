// A terminal worker whose terminal a daemon loss or reboot took, resumed once in its own conversation.

import { isResumableTuiAgent } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import {
  readWorkerResumeSession,
  type WorkerResumeSession
} from '../dispatch-context/worker-follow-up-lineage'
import { readWorkerPresence, type WorkerPresence } from '../worker-presence/worker-presence-store'
import type { OrchestrationDb } from '../orchestration-db'

/** Marks a Dispatch whose worker was resumed after a restart; a second loss is not resumed again. */
export const WORKER_RESTART_RESUMED_STAGE = 'restart_resumed'
/** A lost worker whose resume waits on a person, as a cut chat does with Resume work on restart off. */
export const WORKER_RESTART_OFFERED_STAGE = 'restart_offered'

export type WorkerRestartStage =
  | typeof WORKER_RESTART_RESUMED_STAGE
  | typeof WORKER_RESTART_OFFERED_STAGE

export type WorkerRestartResumeClaim = {
  dispatchId: string
  worktreeId: string
  session: WorkerResumeSession
  /** What the worker was doing when its terminal went: only `working` is asked to continue. */
  presence: Exclude<WorkerPresence, 'gone'> | null
}

/**
 * Claims an open Dispatch's one restart resume. Refuses a Dispatch already resumed once, one its
 * coordinator stopped or released, one still starting or already gone, and a conversation this
 * host cannot resume. The claim is durable before any agent starts, so a crash mid-resume never loops.
 */
export function claimWorkerRestartResume(
  db: OrchestrationDb,
  dispatchId: string,
  stage: WorkerRestartStage = WORKER_RESTART_RESUMED_STAGE
): WorkerRestartResumeClaim | null {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const claim = readClaimable(db, dispatchId)
    if (claim) {
      db.db
        .prepare(
          `UPDATE worker_dispatches SET stage = ?, updated_at = datetime('now')
            WHERE dispatch_id = ? AND state = 'ready'`
        )
        .run(stage, dispatchId)
    }
    db.db.exec('COMMIT')
    return claim
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

/** The claim a lost worker's restart takes, logged; a failed read leaves today's outcome. */
export function claimLostWorkerRestart(
  db: OrchestrationDb | null,
  dispatchId: string,
  stage: WorkerRestartStage
): WorkerRestartResumeClaim | null {
  try {
    const claim = db ? claimWorkerRestartResume(db, dispatchId, stage) : null
    if (claim) {
      console.info('[orchestration] holding a terminal worker for its restart resume', {
        dispatchId,
        presence: claim.presence,
        stage
      })
    }
    return claim
  } catch (error) {
    console.warn('[orchestration] claiming a worker restart resume failed', dispatchId, error)
    return null
  }
}

function readClaimable(db: OrchestrationDb, dispatchId: string): WorkerRestartResumeClaim | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const session = readWorkerResumeSession(resource)
  const presence = readWorkerPresence(db, dispatchId)?.presence ?? null
  if (
    !dispatch ||
    (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
    worker?.state !== 'ready' ||
    worker.stage === WORKER_RESTART_RESUMED_STAGE ||
    !resource?.worktree_id ||
    resource.ownership_state !== 'owned' ||
    resource.release_state !== 'not_requested' ||
    !session ||
    !isResumableTuiAgent(session.agent) ||
    // A transcript is readable only on the host that recorded it.
    session.captureHostId !== LOCAL_EXECUTION_HOST_ID ||
    presence === 'gone'
  ) {
    return null
  }
  return { dispatchId, worktreeId: resource.worktree_id, session, presence }
}

/** An offered resume no person has taken or dismissed yet. */
export function isWorkerRestartOffered(db: OrchestrationDb, dispatchId: string): boolean {
  return (
    db.getWorkerDispatch(dispatchId)?.stage === WORKER_RESTART_OFFERED_STAGE &&
    isWorkerRestartResumeOpen(db, dispatchId)
  )
}

export type WorkerRestartOffer = WorkerRestartResumeClaim & {
  /** The task's own name, else its spec: what the person sees the worker as. */
  taskName: string
  offeredAt: number
}

/** Every open Dispatch whose lost worker waits on a person's Resume or dismissal. */
export function listWorkerRestartOffers(db: OrchestrationDb): WorkerRestartOffer[] {
  return db.db
    .prepare(
      `SELECT w.dispatch_id AS dispatch_id, w.updated_at AS updated_at,
              COALESCE(NULLIF(t.display_name, ''), NULLIF(t.task_title, ''), t.spec) AS spec
         FROM worker_dispatches w
         JOIN dispatch_contexts c ON c.id = w.dispatch_id
         JOIN tasks t ON t.id = c.task_id
        WHERE w.stage = ?`
    )
    .all(WORKER_RESTART_OFFERED_STAGE)
    .flatMap((row) => {
      const dispatchId = typeof row.dispatch_id === 'string' ? row.dispatch_id : null
      const claim =
        dispatchId && isWorkerRestartResumeOpen(db, dispatchId) ? readOffer(db, dispatchId) : null
      return claim
        ? [
            {
              ...claim,
              taskName: typeof row.spec === 'string' ? row.spec : '',
              offeredAt: Date.parse(`${String(row.updated_at)}Z`) || Date.now()
            }
          ]
        : []
    })
}

function readOffer(db: OrchestrationDb, dispatchId: string): WorkerRestartResumeClaim | null {
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const session = readWorkerResumeSession(resource)
  const presence = readWorkerPresence(db, dispatchId)?.presence ?? null
  return resource?.worktree_id && session && presence !== 'gone'
    ? { dispatchId, worktreeId: resource.worktree_id, session, presence }
    : null
}

/** A claimed resume may still start: its coordinator has not stopped or released the Dispatch since. */
export function isWorkerRestartResumeOpen(db: OrchestrationDb, dispatchId: string): boolean {
  const dispatch = db.getDispatchContextById(dispatchId)
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  return (
    (dispatch?.status === 'pending' || dispatch?.status === 'dispatched') &&
    db.getWorkerDispatch(dispatchId)?.state === 'ready' &&
    resource?.ownership_state === 'owned' &&
    resource.release_state === 'not_requested'
  )
}

/** Points the Dispatch, its worker and its terminal resource at the terminal its agent resumed in. */
export function rebindRestartedWorkerTerminal(
  db: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    hostScope?: string | null
  }
): boolean {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = db.getDispatchContextById(params.dispatchId)
    const worker = db.getWorkerDispatch(params.dispatchId)
    if (
      !dispatch ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
      worker?.state !== 'ready'
    ) {
      db.db.exec('COMMIT')
      return false
    }
    db.db
      .prepare(
        `UPDATE dispatch_contexts
            SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?,
                host_scope = COALESCE(?, host_scope), consumer_generation = consumer_generation + 1
          WHERE id = ?`
      )
      .run(
        params.handle,
        params.paneKey,
        params.processIncarnation,
        params.hostScope ?? null,
        params.dispatchId
      )
    db.db
      .prepare(
        `UPDATE worker_dispatches SET agent_terminal_handle = ?, updated_at = datetime('now')
          WHERE dispatch_id = ?`
      )
      .run(params.handle, params.dispatchId)
    db.db
      .prepare(
        `UPDATE worker_terminal_resources
            SET terminal_handle = ?, pane_key = ?, process_incarnation = ?,
                endpoint_incarnation = ?, host_scope = COALESCE(?, host_scope),
                updated_at = datetime('now')
          WHERE owner_dispatch_id = ? AND ownership_state = 'owned'`
      )
      .run(
        params.handle,
        params.paneKey,
        params.processIncarnation,
        params.processIncarnation,
        params.hostScope ?? null,
        params.dispatchId
      )
    // Mail the lost terminal never acknowledged is delivered again to the resumed one.
    db.fenceUnacknowledgedMailboxDeliveries(`dispatch:${params.dispatchId}`)
    db.db.exec('COMMIT')
    return true
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
