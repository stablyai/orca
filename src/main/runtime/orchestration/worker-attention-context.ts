import type { FleetAgentStatusEvidence } from '../../../shared/orchestration-fleet-agent-status-evidence'
import { projectOrchestrationFleetAttention } from '../../../shared/orchestration-fleet-attention'
import { resolveFleetWorkerOutcome } from '../../../shared/orchestration-fleet-outcome-resolution'
import {
  projectLiveness,
  SETTLED_WORKER_STATES
} from '../../../shared/orchestration-fleet-worker-projection'
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
  const liveness = projectLiveness(
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
  const outcome = resolveFleetWorkerOutcome({
    attemptOutcome: args.facts.outcome,
    workerState: args.facts.workerState,
    dispatchStatus: args.facts.dispatchStatus
  })
  const fresh = liveness.verdict === 'live'
  const activity = args.evidence?.activity
  const unsettled =
    outcome === 'in_progress' &&
    (!args.facts.workerState || !SETTLED_WORKER_STATES.has(args.facts.workerState)) &&
    args.facts.dispatchStatus !== 'completed' &&
    args.facts.dispatchStatus !== 'failed' &&
    args.facts.dispatchStatus !== 'circuit_broken'
  const stoppedWithoutWorkerDone =
    unsettled &&
    fresh &&
    (activity?.state === 'done' || activity?.state === 'waiting') &&
    !args.facts.pendingInput &&
    !args.facts.pendingApproval
  return projectOrchestrationFleetAttention({
    isRoot: args.isRoot,
    outcome,
    pendingInput: args.facts.pendingInput,
    pendingGuidance: args.facts.pendingGuidance,
    pendingApproval: args.facts.pendingApproval,
    interrupted:
      args.facts.terminationReason === 'operator_close' ||
      args.facts.terminationReason === 'signaled',
    liveness,
    stoppedWithoutWorkerDone,
    lastAssistantMessage: activity?.lastAssistantMessage ?? undefined
  })
}
