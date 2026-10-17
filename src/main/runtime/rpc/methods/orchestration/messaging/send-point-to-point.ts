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
import { z } from 'zod'

type SendParamsInput = z.infer<typeof SendParams>
const JsonObject = z.record(z.string(), z.unknown())
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
  providerAttested: boolean
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
    providerAttested,
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
    const taskId = isDispatchMutationMessageType(messageType)
      ? parseMessageTaskId(params.payload)
      : undefined
    const coordinatorMutation = messageType === 'escalation' || messageType === 'decision_gate'
    const refusal = isDispatchMutationMessageType(messageType)
      ? lifecycleRefusal({
          db,
          dispatch,
          from,
          paneKey: senderPaneKey,
          processIncarnation,
          taskId,
          coordinatorMutation
        })
      : null
    const msg = db.insertMessage({
      from,
      to,
      subject: params.subject,
      body: params.body,
      type: messageType,
      priority: params.priority as MessagePriority,
      threadId: params.threadId,
      payload: bindProviderSenderAttestation({
        payload: dispatch
          ? bindCoordinatorMutationPayload(messageType, params.payload, dispatch.id)
          : params.payload,
        dispatch,
        taskId,
        from,
        paneKey: senderPaneKey,
        processIncarnation,
        consumerGeneration: dispatch?.consumer_generation,
        attested: providerAttested && refusal === null && isDispatchMutationMessageType(messageType)
      }),
      senderPaneKey,
      runId: messageRunId,
      deliveryContract: legacyWorkerDeliveryContract(
        runtime,
        messageRunId ?? legacyCoordinatorRunId,
        to
      )
    })
    if (isDispatchMutationMessageType(msg.type)) {
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

function bindProviderSenderAttestation(args: {
  payload: string | null | undefined
  dispatch: ReturnType<OrchestrationDb['getDispatchContextById']>
  taskId: string | undefined
  from: string
  paneKey: string | undefined
  processIncarnation: string | undefined
  consumerGeneration: number | undefined
  attested: boolean
}): string | undefined {
  let parsed: Record<string, unknown> = {}
  if (args.payload) {
    try {
      const value: unknown = JSON.parse(args.payload)
      const object = JsonObject.safeParse(value)
      if (object.success) {
        const { providerSenderAttestation: _forged, ...rest } = object.data
        parsed = rest
      } else if (!args.attested) {
        return args.payload
      }
    } catch {
      return args.payload
    }
  }
  if (!args.attested || !args.dispatch || !args.paneKey || !args.processIncarnation) {
    return args.payload ? JSON.stringify(parsed) : undefined
  }
  return JSON.stringify({
    ...parsed,
    providerSenderAttestation: {
      version: 1,
      dispatchId: args.dispatch.id,
      taskId: args.taskId ?? args.dispatch.task_id,
      runId: args.dispatch.run_id,
      consumerGeneration: args.consumerGeneration,
      terminalHandle: args.from,
      paneKey: args.paneKey,
      processIncarnation: args.processIncarnation
    }
  })
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
