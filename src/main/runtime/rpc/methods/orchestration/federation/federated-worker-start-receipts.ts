import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import { startingWorkerNextCommands } from '../worker/worker-start-receipt'

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
  prompt?: unknown
  failedStage?: string
  lastError?: string
}

export function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported'
  ].includes(code)
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

/** A remote start still attaching when a capped caller stops waiting: its durable `starting`. */
export function federatedInProgressReceipt(
  db: OrchestrationDb,
  dispatchId: string,
  taskId: string,
  server: { name: string },
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  const worker = db.getWorkerDispatch(dispatchId)
  return {
    taskId,
    dispatchId,
    state: 'starting',
    stage: worker?.stage ?? 'remote_attach_requested',
    server: { name: server.name },
    launch,
    effects: [],
    residualResources: [],
    nextCommands: startingWorkerNextCommands(dispatchId)
  }
}
