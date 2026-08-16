import type { OrchestrationDb } from '../../orchestration/db'
import { isFederationEffectUnknown } from './orchestration-federation-effects'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

const KNOWN_REMOTE_START_FAILURES = new Set([
  'invalid_argument',
  'agent_unconfigured',
  'worktree_not_found_on_server',
  'terminal_worktree_mismatch',
  'capability_unsupported',
  'bounded_worker_requires_fresh_process',
  'leaf_control_unsupported',
  'runtime_budget_exhausted'
])

export function isKnownRemoteStartFailure(code: string): boolean {
  return KNOWN_REMOTE_START_FAILURES.has(code)
}

export type RemoteStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

export function failFederatedAttachmentWithReceipt(args: {
  db: OrchestrationDb
  dispatchId: string
  runtimeEpoch: string
  failedStage: string
  error: unknown
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
}): unknown {
  const reason = args.error instanceof Error ? args.error.message : String(args.error)
  const settled = args.db.getRemoteDispatchAttachment(args.dispatchId)
  if (settled && ['stopped', 'stop_unknown'].includes(settled.state)) {
    return {
      dispatchId: args.dispatchId,
      state: settled.state,
      stage: settled.stage,
      runtimeEpoch: args.runtimeEpoch,
      failedStage: settled.stage,
      lastError: settled.last_error,
      setup: args.setup,
      launch: args.launch,
      effects: JSON.parse(settled.effects) as unknown[],
      residualResources: JSON.parse(settled.residual_resources) as unknown[]
    }
  }
  const unknown = isFederationEffectUnknown(args.error, args.failedStage)
  const attachment = args.db.failRemoteAttachment(
    args.dispatchId,
    args.failedStage,
    reason,
    unknown
  )
  return {
    dispatchId: args.dispatchId,
    state: attachment.state === 'start_unknown' ? 'outcome_unknown' : attachment.state,
    stage: attachment.stage,
    runtimeEpoch: args.runtimeEpoch,
    failedStage: args.failedStage,
    lastError: reason,
    setup: args.setup,
    launch: args.launch,
    effects: JSON.parse(attachment.effects) as unknown[],
    residualResources: JSON.parse(attachment.residual_resources) as unknown[]
  }
}

export function settleFederatedStartRuntimeReceipt(args: {
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  server: { environmentId: string; name: string }
  remote: {
    state: string
    stage?: string
    lastError?: string
    setup?: { state: string }
    effects?: unknown[]
    residualResources?: unknown[]
  }
  launch: OrchestrationWorkerLaunchReceipt
  bounded: { deadlineAt: string; budget: unknown; leafControl: unknown }
}): unknown {
  const reason =
    args.remote.lastError ??
    (args.remote.state === 'stop_unknown'
      ? 'runtime_budget_stop_unknown'
      : 'worker_exited_without_report')
  const worker = args.db.settleFederatedStartRuntimeFailure({
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    reason,
    result: JSON.stringify({ reason, dispatchId: args.dispatchId })
  })
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: worker.state,
    stage: worker.stage,
    server: args.server,
    failedStage: worker.stage,
    lastError: worker.last_error,
    setup: args.remote.setup,
    launch: args.launch,
    ...args.bounded,
    effects: args.remote.effects ?? [],
    residualResources: args.remote.residualResources ?? []
  }
}
