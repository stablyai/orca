import type { MessagePriority, MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { reconcileLifecycleMessage } from '../../../../orchestration/lifecycle-reconciliation'
import { bindCoordinatorMutationPayload } from '../../../../orchestration/dispatch-message-binding'
import { isDispatchMutationMessageType, parseMessageTaskId } from '../schemas'
import type { SendParams } from '../schemas'
import { legacyWorkerDeliveryContract } from '../routing'
import { exposeMessage } from './mailbox-message-receipt'
import { recordReceiptForPostCommitNudge } from './mutation-replay-nudge'
import type { SendRecipientWarning } from './recipient-routing'
import {
  workerReportRefusal,
  type WorkerReportRefusal
} from '../../../../orchestration/worker-report-admission'
import type { z } from 'zod'

type SendParamsInput = z.infer<typeof SendParams>
type SendReceipt = <T extends object>(receipt: T) => T & { warnings?: SendRecipientWarning[] }

export function sendPointToPointMessage(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  to: string
  dispatchId: string | undefined
  messageRunId: string | undefined
  senderPaneKey: string | undefined
  legacyCoordinatorRunId: string | undefined
  resolveProcessIncarnation: () => string | undefined
  revalidateLegacyCoordinator: (() => string) | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  markWorkerDoneMutationEffectFree: (() => void) | undefined
  withSendWarnings: SendReceipt
}): unknown {
  const {
    params,
    runtime,
    db,
    from,
    to,
    dispatchId,
    messageRunId,
    senderPaneKey,
    legacyCoordinatorRunId,
    resolveProcessIncarnation,
    revalidateLegacyCoordinator,
    recordMutationReceipt,
    markWorkerDoneMutationEffectFree,
    withSendWarnings
  } = args
  // Point-to-point — existing single-recipient behavior
  revalidateLegacyCoordinator?.()
  const messageType = (params.type ?? 'status') as MessageType
  const processIncarnation = isDispatchMutationMessageType(messageType)
    ? resolveProcessIncarnation()
    : undefined
  const commitMessage = (): { receipt: unknown; nudge: () => void } => {
    const dispatch = dispatchId ? db.getDispatchContextById(dispatchId) : undefined
    const msg = db.insertMessage({
      from,
      to,
      subject: params.subject,
      body: params.body,
      type: messageType,
      priority: params.priority as MessagePriority,
      threadId: params.threadId,
      payload: dispatch
        ? bindCoordinatorMutationPayload(messageType, params.payload, dispatch.id)
        : params.payload,
      senderPaneKey,
      runId: messageRunId,
      deliveryContract: legacyWorkerDeliveryContract(
        runtime,
        messageRunId ?? legacyCoordinatorRunId,
        to
      )
    })
    if (isDispatchMutationMessageType(msg.type)) {
      const taskId = parseMessageTaskId(params.payload)
      const coordinatorMutation = msg.type === 'escalation' || msg.type === 'decision_gate'
      const refusal = lifecycleRefusal({
        db,
        dispatch,
        from,
        paneKey: senderPaneKey,
        processIncarnation,
        taskId,
        coordinatorMutation
      })
      if (refusal) {
        const rejection =
          db.convertLifecycleMessageToRejection(msg.id, refusal.code, refusal.reason) ?? msg
        const receipt = withSendWarnings({
          message: exposeMessage(rejection),
          lifecycle: {
            action: 'rejected',
            code: refusal.code,
            reason: refusal.reason
          }
        })
        return recordReceiptForPostCommitNudge(recordMutationReceipt, receipt, () =>
          runtime.notifyMessageArrived(rejection.to_handle, rejection.type)
        )
      }
    }

    if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
      const reconciled = reconcileLifecycleMessage(db, msg)
      // Why: a suppressed message is already read, so skip waking a check waiter to an empty result.
      if (reconciled.action === 'suppressed') {
        return recordReceiptForPostCommitNudge(
          recordMutationReceipt,
          withSendWarnings({ message: exposeMessage(msg) }),
          () => undefined
        )
      }
      if (reconciled.action === 'rejected') {
        const rejection = db.getMessageById(msg.id) ?? msg
        const receipt = withSendWarnings({
          message: exposeMessage(rejection),
          lifecycle: reconciled
        })
        return recordReceiptForPostCommitNudge(recordMutationReceipt, receipt, () =>
          runtime.notifyMessageArrived(rejection.to_handle, rejection.type)
        )
      }
      const receipt = withSendWarnings(
        msg.type === 'worker_done'
          ? { message: exposeMessage(msg), lifecycle: reconciled }
          : { message: exposeMessage(msg) }
      )
      return recordReceiptForPostCommitNudge(recordMutationReceipt, receipt, () =>
        runtime.notifyMessageArrived(msg.to_handle, msg.type)
      )
    }
    const receipt = withSendWarnings({ message: exposeMessage(msg) })
    return recordReceiptForPostCommitNudge(recordMutationReceipt, receipt, () =>
      runtime.notifyMessageArrived(msg.to_handle, msg.type)
    )
  }
  // Why: worker_done wakes the Run only after its mailbox row, settlement, and replay receipt commit together.
  if (messageType === 'worker_done') {
    markWorkerDoneMutationEffectFree?.()
  }
  const committed =
    messageType === 'worker_done'
      ? db.commitWorkerDoneMessageMutation(commitMessage)
      : commitMessage()
  committed.nudge()
  return committed.receipt
}

type LifecycleRefusal = {
  code: 'sender_not_assignee' | 'task_dispatch_mismatch' | WorkerReportRefusal['code']
  reason: string
}

function lifecycleRefusal(args: {
  db: OrchestrationDb
  dispatch: ReturnType<OrchestrationDb['getDispatchContextById']>
  from: string
  paneKey: string | undefined
  processIncarnation: string | undefined
  taskId: string | undefined
  coordinatorMutation: boolean
}): LifecycleRefusal | null {
  const { db, dispatch, from, paneKey, processIncarnation, taskId, coordinatorMutation } = args
  if (!dispatch) {
    return coordinatorMutation
      ? {
          code: 'sender_not_assignee',
          reason: 'No active Dispatch belongs to this message sender.'
        }
      : null
  }
  if (coordinatorMutation && taskId && taskId !== dispatch.task_id) {
    return {
      code: 'task_dispatch_mismatch',
      reason: `Task ${taskId} does not belong to Dispatch ${dispatch.id}.`
    }
  }
  const refusal = workerReportRefusal({
    dispatchId: dispatch.id,
    from,
    workerState: db.getWorkerDispatch(dispatch.id)?.state,
    processCurrent:
      !dispatch.process_incarnation ||
      db.isDispatchProcessCurrent({
        dispatchId: dispatch.id,
        paneKey: paneKey ?? null,
        processIncarnation: processIncarnation ?? null
      })
  })
  if (refusal || dispatch.process_incarnation) {
    return refusal
  }
  return !coordinatorMutation ||
    db.isDispatchMessageSender({ dispatchId: dispatch.id, handle: from, paneKey })
    ? null
    : {
        code: 'sender_not_assignee',
        reason: `Terminal ${from} does not own Dispatch ${dispatch.id}.`
      }
}
