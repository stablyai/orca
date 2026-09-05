import type { FleetAgentStatusEvidence } from '../../../shared/orchestration-fleet-agent-status-evidence'
import { projectOrchestrationFleetAttention } from '../../../shared/orchestration-fleet-attention'
import { resolveFleetWorkerOutcome } from '../../../shared/orchestration-fleet-outcome-resolution'
import { projectLiveness } from '../../../shared/orchestration-fleet-worker-projection'
import type { OrchestrationDb } from './db'
import type { WorkerAttentionFacts } from './db/worker-terminal/worker-terminal-attention-query'
import type { DispatchContextRow, TaskRow } from './types'

export function buildWorkerAttentionContext(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  task: TaskRow | undefined
  evidence: FleetAgentStatusEvidence | undefined
  now?: number
}) {
  const now = args.now ?? Date.now()
  const facts = args.db.getWorkerAttentionFacts(args.dispatch.id, now)
  return projectWorkerAttentionContext({
    facts,
    isRoot: facts.isRoot,
    evidence: args.evidence,
    now
  })
}

export function projectWorkerAttentionContext(args: {
  facts: WorkerAttentionFacts
  isRoot: boolean
  evidence: FleetAgentStatusEvidence | undefined
  now: number
}) {
  return projectOrchestrationFleetAttention({
    isRoot: args.isRoot,
    outcome: resolveFleetWorkerOutcome({
      attemptOutcome: args.facts.outcome,
      workerState: args.facts.workerState,
      dispatchStatus: args.facts.dispatchStatus
    }),
    pendingInput: args.facts.pendingInput,
    pendingGuidance: args.facts.pendingGuidance,
    pendingApproval: args.facts.pendingApproval,
    interrupted:
      args.facts.terminationReason === 'operator_close' ||
      args.facts.terminationReason === 'signaled',
    liveness: projectLiveness(
      {
        workerState: args.facts.workerState,
        workerStage: args.facts.workerStage,
        dispatchStatus: args.facts.dispatchStatus,
        terminationReason: args.facts.terminationReason,
        resource:
          args.facts.hostScope === undefined
            ? null
            : { hostScope: args.facts.hostScope, releaseState: args.facts.releaseState }
      },
      args.evidence,
      args.now
    )
  })
}
