import type { MessageType, OrchestrationDb, RunRow } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { interruptedAcknowledgedCheck } from '../routing'
import { checkWorkerMailbox } from './check-worker'
import { currentDispatchAssigneeRun } from './recipient-routing'
import { callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

export async function checkRunPendingMail(args: {
  params: z.infer<typeof CheckParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  handle: string
  paneKey: string | undefined
  callerSession: OrchestrationSessionCaller | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  revalidateConsumer: () => void
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<{ acknowledged?: string; result?: unknown }> {
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
  // Drain pre-bind mail through its original Dispatch owner, never by changing its Run.
  const residual = !params.run ? db.getActiveDispatchForIdentity(handle, paneKey) : undefined
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
          deliveryId: params.ack
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
  if (
    residual &&
    residual.run_id !== run.id &&
    (residual.assignee_orca_session_id === null ||
      residual.assignee_orca_session_id === caller.orcaSessionId) &&
    callerHoldsDispatchPane(residual, paneKey) &&
    currentDispatchAssigneeRun(runtime, db, residual)?.id === run.id &&
    (residualAck || !db.hasOutstandingMailboxDelivery(address))
  ) {
    const result = await checkWorkerMailbox({
      params: { ...params, ack: residualAck, wait: false },
      runtime,
      db,
      handle,
      paneKey,
      typeFilter,
      signal,
      activeDispatch: residual,
      remoteAttachment: undefined,
      wakeTypes: params.wait ? typeFilter : undefined,
      // Accept the original owner's ack without creating a batch ahead of Run replay.
      deferDelivery: () => db.hasOutstandingMailboxDelivery(address),
      revalidateConsumer: () => {
        revalidateConsumer()
        const current = db.getActiveDispatchForIdentity(handle, paneKey)
        if (
          !current ||
          current.id !== residual.id ||
          currentDispatchAssigneeRun(runtime, db, current)?.id !== run.id
        ) {
          throw dispatchFenced()
        }
      },
      recordMutationReceipt
    })
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
