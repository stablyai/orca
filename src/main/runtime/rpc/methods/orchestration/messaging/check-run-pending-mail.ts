import type {
  DispatchContextRow,
  MessageType,
  RunRow
} from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { interruptedAcknowledgedCheck } from '../routing'
import { checkWorkerMailbox } from './check-worker'
import { acknowledgedOnlyReceipt, handsOverBatch } from './mailbox-message-receipt'
import type { CheckMailReconciliation } from './check-mail-reconciliation'
import { currentDispatchAssigneeRun } from './recipient-routing'
import { callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import type {
  OrchestrationEntryCaller,
  OrchestrationSessionCaller
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { CheckParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import type { z } from 'zod'
import {
  asRecoveredAssignee,
  type RemintedWorkerReporter
} from '../../../../orchestration/workers/reports/reminted-worker-reporter'

/** A restart-reissued caller, recovered at entry: its stale handle names no terminal or process. */
export type RecoveredRunChecker = {
  recovered?: RemintedWorkerReporter | null
  processIncarnation?: () => string | null
  recoveredLocalProcessCurrent?: () => boolean
}

export async function checkRunPendingMail(
  args: {
    params: z.infer<typeof CheckParams>
    runtime: OrcaRuntimeService
    db: OrchestrationDb
    run: RunRow
    handle: string
    paneKey: string | undefined
    callerSession: OrchestrationEntryCaller | undefined
    reader: OrchestrationSessionCaller | undefined
    typeFilter: MessageType[] | undefined
    signal: AbortSignal | undefined
    revalidateConsumer: () => void
    reconciliation: CheckMailReconciliation
    recordMutationReceipt: ((receipt: unknown) => void) | undefined
  } & RecoveredRunChecker
): Promise<{ acknowledged?: string; result?: unknown }> {
  const {
    params,
    runtime,
    db,
    run,
    handle,
    paneKey,
    typeFilter,
    signal,
    revalidateConsumer,
    recordMutationReceipt
  } = args
  const generation = run.consumer_generation
  const address = `run:${run.id}`
  const { recovered } = args
  // Drain pre-bind mail through its original Dispatch owner, never by changing its Run. A recovered
  // caller drains only the Dispatch it was recovered as, while its recovered process still holds it.
  const residualFor = (): DispatchContextRow | undefined => {
    const found = !params.run ? db.getActiveDispatchForIdentity(handle, paneKey) : undefined
    return !recovered ||
      (found?.id === recovered.dispatchId && args.recoveredLocalProcessCurrent?.())
      ? found
      : undefined
  }
  const assigneeRun = (dispatch: DispatchContextRow) =>
    currentDispatchAssigneeRun(runtime, db, asRecoveredAssignee(dispatch, recovered))
  const residual = residualFor()
  const caller = orchestrationCallerIdentity(runtime, {
    handle,
    paneKey,
    session: args.callerSession
  })
  const residualAck =
    params.ack &&
    residual &&
    db.getDeliveryRaw(params.ack)?.mailbox_handle === `dispatch:${residual.id}`
      ? params.ack
      : undefined
  const acknowledgeRun = () =>
    params.ack
      ? db.acknowledgeRunDelivery({
          runId: run.id,
          consumerGeneration: generation,
          deliveryId: params.ack,
          taker: args.reconciliation.taker
        })
      : undefined
  let acknowledged: { delivery: { id: string } } | undefined = residualAck
    ? undefined
    : acknowledgeRun()
  const recordAcknowledged = () => {
    if (acknowledged) {
      recordMutationReceipt?.(
        interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'outcome_unknown')
      )
    }
  }
  recordAcknowledged()
  if (acknowledged && !params.wait) {
    const result = acknowledgedOnlyReceipt({ runId: run.id }, acknowledged.delivery.id)
    return { acknowledged: acknowledged.delivery.id, result }
  }
  if (
    residual &&
    residual.run_id !== run.id &&
    (residual.assignee_orca_session_id === null ||
      residual.assignee_orca_session_id === caller.orcaSessionId) &&
    callerHoldsDispatchPane(residual, paneKey) &&
    assigneeRun(residual)?.id === run.id &&
    (residualAck || !db.hasOutstandingMailboxDelivery(address))
  ) {
    const result = await checkWorkerMailbox({
      params: { ...params, ack: residualAck, wait: false },
      reader: args.reader,
      runtime,
      db,
      handle,
      paneKey,
      typeFilter,
      signal,
      activeDispatch: residual,
      remoteAttachment: undefined,
      processIncarnation:
        args.processIncarnation ?? (() => runtime.getTerminalProcessIncarnation(handle)),
      recovered,
      recoveredLocalProcessCurrent: args.recoveredLocalProcessCurrent,
      wakeTypes: params.wait ? typeFilter : undefined,
      // Accept the original owner's ack without creating a batch ahead of Run replay.
      deferDelivery: () => db.hasOutstandingMailboxDelivery(address),
      revalidateConsumer: () => {
        revalidateConsumer()
        const current = residualFor()
        if (!current || current.id !== residual.id || assigneeRun(current)?.id !== run.id) {
          throw dispatchFenced()
        }
      },
      recordMutationReceipt,
      reconciliation: args.reconciliation,
      runAcknowledged: acknowledged?.delivery.id,
      acknowledgeOnly: !params.wait
    })
    if (handsOverBatch(result) || (residualAck && !params.wait)) {
      return { acknowledged: result?.acknowledged ?? undefined, result }
    }
    if (result?.acknowledged) {
      acknowledged = { delivery: { id: result.acknowledged } }
    }
    recordAcknowledged()
    try {
      revalidateConsumer()
    } catch (error) {
      if (acknowledged) {
        return {
          acknowledged: acknowledged.delivery.id,
          result: interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
        }
      }
      throw error
    }
    const inspectingHistory =
      params.all === true || (params.unread === false && params.peek !== true)
    if (
      result &&
      result.count > 0 &&
      (!inspectingHistory || db.getUnreadMessages(`dispatch:${residual.id}`).length > 0)
    ) {
      return {
        acknowledged: acknowledged?.delivery.id,
        result: { ...result, acknowledged: acknowledged?.delivery.id ?? null }
      }
    }
  }

  // A supplied Delivery outside this caller's current Dispatch must still fail acknowledgment.
  if (params.ack && !acknowledged) {
    acknowledgeRun()
  }
  return { acknowledged: acknowledged?.delivery.id }
}
