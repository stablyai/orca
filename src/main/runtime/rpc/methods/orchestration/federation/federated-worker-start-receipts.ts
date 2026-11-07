import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'

export function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported'
  ].includes(code)
}

type FederatedStartWorker = {
  dispatch_id: string
  state: string
  stage: string
  last_error: string | null
}

export function federatedFailedReceipt(
  worker: FederatedStartWorker,
  ids: { runId: string; taskId: string },
  server: { environmentId: string; name: string },
  outcome: {
    launch: OrchestrationWorkerLaunchReceipt
    setup?: { state: string }
    effects?: unknown[]
    residualResources?: unknown[]
  }
): unknown {
  return {
    ...ids,
    dispatchId: worker.dispatch_id,
    state: worker.state,
    stage: worker.stage,
    server: { environmentId: server.environmentId, name: server.name },
    failedStage: worker.stage,
    lastError: worker.last_error,
    ...outcome,
    effects: outcome.effects ?? [],
    residualResources: outcome.residualResources ?? []
  }
}

export function federatedUnknownReceipt(
  worker: FederatedStartWorker,
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
