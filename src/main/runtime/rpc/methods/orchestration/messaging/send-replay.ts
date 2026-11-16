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
import { observeStoredSend } from './stored-message-delivery'
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
    return { receipt: observeStoredSend(runtime, replayedMutationReceipt, caller) }
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
  return { receipt: observeStoredSend(runtime, receipt, caller) }
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
