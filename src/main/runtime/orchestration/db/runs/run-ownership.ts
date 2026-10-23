import { OrchestrationError } from '../../orchestration-error'
import type { RunRow } from '../../types'
import { runBoundToCoordinator, runCoordinatorKey } from '../../orchestration-caller-identity'
import type { OrchestrationDb } from '../orchestration-db'
import {
  resolveRunActor,
  sameExactCaller,
  refuseRunAuthority,
  type RunCallerKey
} from './run-actor'
import {
  decodeRunCaller,
  getRunAuthority,
  getRunHandover,
  lastRunCaller
} from './run-authority-store'
import { assertActorCanCoordinate, assertTaskCanOwnRun } from './run-lineage'

export function authorizeRunBinding(
  db: OrchestrationDb,
  run: RunRow,
  caller: RunCallerKey,
  takeover: boolean
): {
  worker: boolean
  unchanged: boolean
  grantAccepted: boolean
  priorAttempt: boolean
} {
  const actor = resolveRunActor(db, caller)
  const authority = getRunAuthority(db, run.id)
  const handover = getRunHandover(db, run.id)
  assertActorCanCoordinate(db, actor, run.id)
  const unchanged =
    runBoundToCoordinator(run, caller) &&
    Boolean(authority && sameExactCaller(lastRunCaller(authority), caller))
  if (actor.kind !== 'root' && takeover && !unchanged) {
    throw new OrchestrationError(
      'worker_cannot_take_over_run',
      'A worker cannot use a takeover flag. Ask this Run’s coordinator for a hand-over with run-handover. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const callerTarget = handover?.target_caller_key
    ? decodeRunCaller(handover.target_caller_key)
    : null
  const grantAccepted = Boolean(
    handover &&
    handover.expires_at > Date.now() &&
    ((callerTarget && sameExactCaller(callerTarget, caller)) ||
      (actor.kind === 'local' && handover.target_task_id === actor.dispatch.task_id))
  )
  if (grantAccepted && handover?.target_task_id) {
    assertTaskCanOwnRun(db, handover.target_task_id, run.id)
  }
  const taskOwner =
    actor.kind === 'local' &&
    authority?.owner_home_peer === null &&
    authority.owner_task_id === actor.dispatch.task_id
  if (actor.kind !== 'root' && !unchanged && !grantAccepted && !taskOwner) {
    refuseRunAuthority(
      actor.kind === 'remote'
        ? 'Remote workers need an explicit hand-over to this exact agent process before acquiring a Run.'
        : 'This Run is not owned by your Task. Ask its current or last coordinator to hand it over; older Runs may need recovery by a non-worker coordinator first.'
    )
  }
  if (actor.kind === 'local' && unchanged && !taskOwner && authority?.owner_task_id !== null) {
    refuseRunAuthority('This Run belongs to a different Task. Ask its coordinator for a hand-over.')
  }
  let priorAttempt = false
  if (!unchanged && taskOwner && actor.kind === 'local' && authority) {
    const key = lastRunCaller(authority)
    const seat = runCoordinatorKey(run)
    if (sameExactCaller(key, { ...seat, processIncarnation: key.processIncarnation })) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Projection contains only the three selected identity columns.
      const attempts = db.db
        .prepare(`SELECT assignee_handle, assignee_orca_session_id, assignee_pane_key, process_incarnation
        FROM dispatch_contexts WHERE task_id = ? AND id != ?`)
        .all(actor.dispatch.task_id, actor.dispatch.id) as {
        assignee_handle: string | null
        assignee_orca_session_id: RunCallerKey['orcaSessionId']
        assignee_pane_key: string | null
        process_incarnation: string | null
      }[]
      priorAttempt = attempts.some((attempt) =>
        sameExactCaller(key, {
          terminalHandle: attempt.assignee_handle,
          paneKey: attempt.assignee_pane_key,
          orcaSessionId: attempt.assignee_orca_session_id,
          processIncarnation: attempt.process_incarnation
        })
      )
    }
  }
  return { worker: actor.kind !== 'root', unchanged, grantAccepted, priorAttempt }
}

export function acceptRunHandover(db: OrchestrationDb, runId: string): void {
  const handover = getRunHandover(db, runId)
  if (!handover) {
    refuseRunAuthority('This hand-over is no longer available.')
  }
  db.db
    .prepare('UPDATE run_authority SET owner_task_id = ?, owner_home_peer = NULL WHERE run_id = ?')
    .run(handover.target_task_id, runId)
  db.db.prepare('DELETE FROM run_handovers WHERE run_id = ?').run(runId)
}
