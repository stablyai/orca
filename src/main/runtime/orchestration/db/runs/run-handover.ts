import type { OrchestrationDb } from '../orchestration-db'
import {
  requireExactCaller,
  resolveRunActor,
  refuseRunAuthority,
  sameExactCaller,
  type RunCallerKey
} from './run-actor'
import { getRunAuthority, lastRunCaller, storeRunHandover } from './run-authority-store'
import { assertActorCanCoordinate, assertTaskCanOwnRun } from './run-lineage'

export type RunHandoverTarget = { taskId: string } | { caller: RunCallerKey }

export function issueRunHandover(
  db: OrchestrationDb,
  params: {
    runId: string
    caller: RunCallerKey
    target: RunHandoverTarget
    recordReceipt?: (result: unknown) => void
  }
): { runId: string; expiresAt: number } {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const actor = resolveRunActor(db, params.caller)
    const authority = getRunAuthority(db, params.runId)
    if (
      !db.getRun(params.runId) ||
      !authority ||
      !sameExactCaller(lastRunCaller(authority), params.caller)
    ) {
      refuseRunAuthority('Only this Run’s current or last proven coordinator can hand it over.')
    }
    assertActorCanCoordinate(db, actor, params.runId)
    if (actor.kind === 'remote') {
      refuseRunAuthority(
        'A remote worker cannot verify current Task ownership on this host and cannot issue a hand-over.'
      )
    }
    if (
      actor.kind === 'local' &&
      (authority.owner_home_peer !== null || authority.owner_task_id !== actor.dispatch.task_id)
    ) {
      refuseRunAuthority('A worker can hand over only a Run owned by its current Task.')
    }
    if ('taskId' in params.target) {
      assertTaskCanOwnRun(db, params.target.taskId, params.runId)
    } else {
      requireExactCaller(params.target.caller)
      assertActorCanCoordinate(db, resolveRunActor(db, params.target.caller), params.runId)
    }
    const receipt = { runId: params.runId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
    storeRunHandover(db, {
      run_id: params.runId,
      grantor_key: JSON.stringify(params.caller),
      target_task_id: 'taskId' in params.target ? params.target.taskId : null,
      target_caller_key: 'caller' in params.target ? JSON.stringify(params.target.caller) : null,
      expires_at: receipt.expiresAt
    })
    params.recordReceipt?.(receipt)
    db.db.exec('COMMIT')
    return receipt
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
