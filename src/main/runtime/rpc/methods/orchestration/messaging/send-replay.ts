import type { RpcContext } from '../../../core'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { handBackReplayTargets } from '../../../../orchestration/db/messages/helper-mailbox-hand-back'
import {
  readMutationReplayNudge,
  readWorkerDoneReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration/mutations/orchestration-mutation-receipt'
import { replayMutationNudge } from './mutation-replay-nudge'
import type { SendParams } from './send-params'
import { followThroughWorkerReport, settledDispatchId } from './settled-worker-follow-through'
import { withDeliveryHoldWarning } from './send-delivery-hold'
import { createStructuredMailboxPointerHost } from '../../../../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host'
import type { OrchestrationPartyIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'

/** An accepted send's replay redelivers its nudge and follow-through; undefined when it carries none. */
export function replayAcceptedSend(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof SendParams>,
  replayedMutationReceipt: unknown,
  caller?: OrchestrationPartyIdentity
): { receipt: unknown } | undefined {
  const legacyReplayNudge = readWorkerDoneReplayNudge(
    'orchestration.send',
    params,
    replayedMutationReceipt
  )
  const replayNudge =
    readMutationReplayNudge(replayedMutationReceipt) ??
    (legacyReplayNudge ? { kind: 'messages' as const, targets: [legacyReplayNudge] } : undefined)
  if (!replayNudge) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  replayMutationNudge(runtime, replayNudge)
  const settled =
    params.type === 'worker_done' ? settledDispatchId(replayedMutationReceipt) : undefined
  // Why: derived, since the executor's receipt rewrites drop stored hand-back targets.
  for (const target of settled ? handBackReplayTargets(db, settled) : []) {
    runtime.notifyMessageArrived(target.to, target.type)
  }
  followThroughWorkerReport(runtime, db, settled)
  const receipt = stripMutationReplayNudge(replayedMutationReceipt)
  return { receipt: refreshHeldReceipt(runtime, receipt, caller) }
}

async function refreshHeldReceipt(
  runtime: OrcaRuntimeService,
  receipt: unknown,
  caller?: OrchestrationPartyIdentity
) {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('state' in receipt) ||
    receipt.state !== 'held' ||
    !('message' in receipt) ||
    !receipt.message ||
    typeof receipt.message !== 'object' ||
    !('id' in receipt.message) ||
    typeof receipt.message.id !== 'string' ||
    !('to_handle' in receipt.message) ||
    typeof receipt.message.to_handle !== 'string'
  ) {
    return receipt
  }
  const { state: _state, ...saved } = receipt
  const clean = Object.fromEntries(
    Object.entries(saved).filter(
      ([key]) =>
        ![
          'delivered',
          'reason',
          'failureId',
          'target',
          'waiting',
          'resetsAt',
          'recoveryUsed',
          'workerName',
          'provider',
          'deliveryMessage',
          'deliveryHint'
        ].includes(key)
    )
  )
  const recipient = receipt.message.to_handle
  const db = runtime.getOrchestrationDb()
  const current = await withDeliveryHoldWarning(clean, runtime, db, recipient, caller)
  if ('state' in current) {
    return current
  }
  const attempt = db.getStructuredMailSend(recipient, receipt.message.id)
  const observed = attempt
    ? await createStructuredMailboxPointerHost().observeMail?.(attempt)
    : undefined
  const accepted = observed?.state.kind === 'accepted'
  const waiting = observed?.state.kind === 'waiting'
  return {
    ...current,
    delivered: accepted,
    state: accepted ? 'delivered' : waiting ? 'queued' : 'unknown',
    deliveryMessage: accepted
      ? 'Delivered.'
      : waiting
        ? 'Queued. Delivers when the worker is ready.'
        : 'Message kept. Delivery is unconfirmed.'
  }
}

export function replayAcceptedSendForCaller(
  params: z.infer<typeof SendParams>,
  { runtime, replayedMutationReceipt, orchestrationCaller }: RpcContext
) {
  return replayAcceptedSend(
    runtime,
    params,
    replayedMutationReceipt,
    orchestrationCaller
      ? orchestrationCallerIdentity(runtime, {
          handle: params.from ?? 'unknown',
          paneKey: null,
          session: orchestrationCaller
        })
      : undefined
  )
}
