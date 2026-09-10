import type { OrchestrationDb } from '../../../../orchestration/db'
import { isAgentPromptStalledError } from '../../../../agent-prompt-submission-verification'
import type { WorkerSetupReceipt } from './worker-topology'
import { isUnknownWorkerStartOutcome } from './worker-start-outcome-classification'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import {
  createWorkerStartRecoveryCommand,
  isReadinessUnverifiable
} from '../../orchestration-worker-start'
import { isAgentSessionPtyWriteRefusedError } from '../../../../../../shared/agent-session-pty-write-admission'
import { structuredChatPtyWriteRefusalCopy } from '../../../../../../shared/agent-session-pty-write-refusal-copy'
import { boundedRedactedDiagnostic } from '../../orchestration-worker-start-diagnostic'
export { boundedRedactedDiagnostic } from '../../orchestration-worker-start-diagnostic'

import type { FailedStartTerminalAdoption } from '../../../../orchestration/db/worker-terminal/failed-start-terminal-adoption'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'

export function failWorkerStartWithReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  attemptId?: string
  terminalHandle?: string
  leaseId?: string
  /** The terminal this start created and never handed to an owner. */
  residualAgentTerminal?: FailedStartTerminalAdoption
  mode?: WorkerStartModeReceipt
}): unknown {
  const agentSessionRefusal = isAgentSessionPtyWriteRefusedError(args.error)
    ? args.error.refusal
    : undefined
  const rawReason =
    (agentSessionRefusal &&
      structuredChatPtyWriteRefusalCopy(agentSessionRefusal, 'worker-start')) ??
    (args.error instanceof Error ? args.error.message : String(args.error))
  const reason = boundedRedactedDiagnostic(rawReason)
  const readinessUnverifiable = isReadinessUnverifiable(args.error, args.failedStage)
  const unknown = readinessUnverifiable || isUnknownWorkerStartOutcome(args.error, args.failedStage)
  const worker = unknown
    ? args.db.markWorkerStartUnknown(args.dispatchId, args.failedStage, reason)
    : args.db.failWorkerStart(args.dispatchId, args.failedStage, reason, {
        // Why (#16095): the preamble is written before submission is verified, so a stalled
        // verdict never means the worker lacks its task — keep the authority its report needs.
        retainCapability: isAgentPromptStalledError(args.error),
        ...(args.residualAgentTerminal ? { adoptResidualTerminal: args.residualAgentTerminal } : {})
      })
  // Only claim cleanup the ownership table actually accepted; the adoption declines a terminal
  // another resource already accounts for.
  const adopted =
    !unknown &&
    Boolean(args.residualAgentTerminal) &&
    Boolean(args.db.getWorkerTerminalResourceByOwner(args.dispatchId))
  const retainedTerminal = Boolean(args.db.getWorkerTerminalResourceByOwner(args.dispatchId))
  return {
    runId: args.runId,
    taskId: args.taskId,
    ...(args.attemptId ? { attemptId: args.attemptId } : {}),
    dispatchId: args.dispatchId,
    ...(args.leaseId ? { leaseId: args.leaseId } : {}),
    ...(args.terminalHandle ? { terminalHandle: args.terminalHandle } : {}),
    readiness: readinessUnverifiable ? 'unverifiable' : 'failed',
    state: worker.state === 'start_unknown' ? 'outcome_unknown' : worker.state,
    stage: worker.stage,
    failedStage: args.failedStage,
    lastError: reason,
    setup: args.setup,
    launch: args.launch,
    ...(args.mode ? { mode: args.mode } : {}),
    effects: JSON.parse(worker.effects) as unknown[],
    residualResources: JSON.parse(worker.residual_resources) as unknown[],
    ...(agentSessionRefusal ? { agentSessionRefusal } : {}),
    ...(adopted
      ? {
          recovery: `This start created a terminal that never ran the Task. Close it with: orca orchestration worker-release --dispatch ${args.dispatchId}`
        }
      : {}),
    ...(unknown
      ? {
          nextCommands: [
            retainedTerminal && !readinessUnverifiable
              ? `orca orchestration worker-abandon --dispatch ${args.dispatchId} --json`
              : createWorkerStartRecoveryCommand({
                  executable: args.launch.effective?.executable ?? 'orca',
                  taskId: args.taskId,
                  dispatchId: args.dispatchId,
                  attemptId: args.attemptId,
                  terminalHandle: args.terminalHandle,
                  // start_unknown is intentionally not strict-retryable.
                  exactRetryAvailable: false
                })
          ]
        }
      : {})
  }
}
