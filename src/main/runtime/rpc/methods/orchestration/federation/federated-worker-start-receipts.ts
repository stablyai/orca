import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import { CAPPED_WORKER_START_REASON } from '../worker/worker-start-caller-cap'

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

/** The same receipt for a remote start a capped caller stops waiting on; nothing is written. */
export function federatedInProgressReceipt(
  db: OrchestrationDb,
  dispatchId: string,
  taskId: string,
  server: { name: string },
  launch: OrchestrationWorkerLaunchReceipt
): unknown {
  const worker = db.getWorkerDispatch(dispatchId)
  return federatedUnknownReceipt(
    {
      dispatch_id: dispatchId,
      state: worker?.state ?? 'starting',
      stage: worker?.stage ?? 'remote_attach_requested',
      last_error: CAPPED_WORKER_START_REASON
    },
    taskId,
    server.name,
    launch
  )
}
