import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { handBackReplayTargets } from '../../../../orchestration/db/messages/helper-mailbox-hand-back'
import {
  readMutationReplayNudge,
  readWorkerDoneReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-receipt'
import { replayMutationNudge } from './mutation-replay-nudge'
import type { SendParams } from './send-params'
import { followThroughWorkerReport, settledDispatchId } from './settled-worker-follow-through'

/** An accepted send's replay redelivers its nudge and follow-through; undefined when it carries none. */
export function replayAcceptedSend(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof SendParams>,
  replayedMutationReceipt: unknown
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
  return { receipt: stripMutationReplayNudge(replayedMutationReceipt) }
}
