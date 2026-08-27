import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

export type FederatedWorkerStartReceipt = {
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

export function isKnownFederatedWorkerStartFailure(code: string): boolean {
  return /^(?:invalid_argument|agent_unconfigured|worktree_not_found_on_server|terminal_worktree_mismatch|capability_unsupported)$/.test(
    code
  )
}

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
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
