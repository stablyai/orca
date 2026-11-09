import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow, MessageRow } from '../../db/orchestration-records'
import {
  resolveWorkerLineage,
  type WorkerLineage
} from '../../db/dispatch-context/worker-follow-up-lineage'
import { selectWorkerFollowUpPlan } from '../../db/dispatch-context/worker-follow-up-plan'
import { hasLifecycleAuthority } from '../lifecycle/lifecycle-reconciliation'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import type { ReportFollowUpAction } from '../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'

const isActive = (dispatch: DispatchContextRow) =>
  dispatch.status === 'pending' || dispatch.status === 'dispatched'

/** The Dispatch that authored an established completion report: a canonical dispatch: sender, or a
 *  worker_done the lifecycle accepted. Never inferred from the terminal's current Dispatch. */
export function completionReportDispatchId(
  db: OrchestrationDb,
  message: MessageRow
): string | undefined {
  if (message.from_handle.startsWith('dispatch:')) {
    return message.from_handle.slice('dispatch:'.length)
  }
  if (message.type !== 'worker_done' || !message.payload) {
    return undefined
  }
  let payload: unknown
  try {
    payload = JSON.parse(message.payload)
  } catch {
    return undefined
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    '_orcaLifecycleRejection' in payload ||
    !('dispatchId' in payload) ||
    typeof payload.dispatchId !== 'string' ||
    !('taskId' in payload)
  ) {
    return undefined
  }
  const dispatch = db.getDispatchContextById(payload.dispatchId)
  return dispatch && dispatch.task_id === payload.taskId && hasLifecycleAuthority(dispatch, message)
    ? dispatch.id
    : undefined
}

/** Undefined while the Dispatch is still active: mail to it reaches its worker. */
export function reportFollowUpAction(
  db: OrchestrationDb,
  dispatchId: string,
  lineageCache?: Map<string, WorkerLineage>
): ReportFollowUpAction | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || isActive(dispatch)) {
    return undefined
  }
  const finishedElsewhere = (id: string): ReportFollowUpAction => {
    const federated = db.getFederatedDispatch(id)
    return federated
      ? { kind: 'worker_start_on', server: federated.environment_name }
      : { kind: 'worker_start' }
  }
  const plan = selectWorkerFollowUpPlan(
    dispatch,
    () => resolveWorkerLineage(db, dispatchId, undefined, lineageCache),
    'status',
    (id) => Boolean(db.getFederatedDispatch(id)),
    (id) => Boolean(db.getWorkerDispatch(id))
  )
  if (plan?.kind === 'start') {
    return { kind: 'send', dispatchId, active: false }
  }
  if (plan?.kind === 'steer') {
    const latest = db.getDispatchContextById(plan.dispatchId)
    return latest && isActive(latest)
      ? { kind: 'send', dispatchId: latest.id, active: true }
      : finishedElsewhere(plan.dispatchId)
  }
  return finishedElsewhere(dispatchId)
}

/** The follow-up a current-contract completion report offers once its task finished.
 *  Pass one `lineageCache` across a batch so reports of one worker share its lineage walk. */
export function completionReportFollowUp(
  db: OrchestrationDb,
  message: MessageRow,
  lineageCache?: Map<string, WorkerLineage>
): ReportFollowUpAction | undefined {
  // Legacy mail is inspect-only.
  if (
    message.type !== 'worker_done' ||
    message.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    message.delivery_contract === 'legacy_direct' ||
    message.delivery_contract === 'audit_only'
  ) {
    return undefined
  }
  const dispatchId = completionReportDispatchId(db, message)
  return dispatchId ? reportFollowUpAction(db, dispatchId, lineageCache) : undefined
}
