// The stand-in's answers about workers already started: stop, release and keep-open, and how list
// and show describe each, in the runtime's shapes.
import { RuntimeClientError } from '../runtime/connection/types'
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import type {
  WorkerListResult,
  WorkerShowResult
} from '../orchestration/workers/worker-view-results'
import type { DispatchStatus } from '../../main/runtime/orchestration/db/orchestration-records'
import { projectOrchestrationFleetAttention } from '../../shared/orchestration/fleet/orchestration-fleet-attention'
import { resolveFleetWorkerOutcome } from '../../shared/orchestration/fleet/orchestration-fleet-outcome-resolution'
import type {
  FleetLiveness,
  OrchestrationFleetWorker
} from '../../shared/orchestration/fleet/orchestration-fleet-projection'
import { EVAL_RUN_ID, workerOrThrow, type StandInWorker } from './bot-orchestration-eval-workers'

export function stop(state: EvalHostState, params: Record<string, unknown>) {
  const worker = workerOrThrow(state, params.dispatch)
  if (worker.state !== 'ready') {
    return {
      dispatchId: worker.dispatchId,
      state: worker.state,
      alreadySettled: true,
      processAction: 'none'
    }
  }
  // A scenario's host where the close cannot be proven: the worker may still be running.
  if (state.stopUnconfirmed) {
    worker.state = 'stop_unknown'
    worker.lastError =
      'The agent terminal was closed but its process could not be confirmed stopped: the stop outcome could not be verified.'
    return {
      dispatchId: worker.dispatchId,
      state: 'stop_unknown',
      alreadySettled: false,
      processAction: 'closed_agent_terminal',
      lastError: worker.lastError
    }
  }
  worker.state = 'stopped'
  worker.terminal = 'released'
  return {
    dispatchId: worker.dispatchId,
    state: 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal'
  }
}

export function release(state: EvalHostState, params: Record<string, unknown>) {
  const worker = workerOrThrow(state, params.dispatch)
  if (worker.terminal === 'released') {
    return { dispatchId: worker.dispatchId, state: 'already_released', processAction: 'none' }
  }
  // Release is cleanup after a worker settled; one that may still run must be stopped first.
  if (worker.state === 'ready' || worker.state === 'stop_unknown') {
    throw new RuntimeClientError(
      'dispatch_inactive',
      `Dispatch ${worker.dispatchId} is ${worker.state}; only a settled worker can release. Use worker-stop to cancel an active worker.`
    )
  }
  worker.terminal = 'released'
  return {
    dispatchId: worker.dispatchId,
    state: 'released',
    processAction: 'closed_agent_terminal',
    archive: { source: 'terminal', status: 'captured' }
  }
}

export function retain(state: EvalHostState, params: Record<string, unknown>) {
  const worker = workerOrThrow(state, params.dispatch)
  if (worker.terminal === 'released') {
    return { dispatchId: worker.dispatchId, state: 'already_released', processAction: 'none' }
  }
  worker.terminal = 'retained'
  return {
    dispatchId: worker.dispatchId,
    state: 'retained',
    reason: 'user_requested',
    processAction: 'none',
    archive: null
  }
}

const DISPATCH_STATUS: Record<StandInWorker['state'], DispatchStatus> = {
  ready: 'dispatched',
  stop_unknown: 'dispatched',
  succeeded: 'completed',
  failed: 'failed',
  stopped: 'failed'
}

// Typed as the runtime's row, so the CLI's list and show views never read a field the stand-in lacks.
function projection(worker: StandInWorker): OrchestrationFleetWorker {
  const exited = worker.terminal === 'released' || worker.state === 'stopped'
  const dispatch = DISPATCH_STATUS[worker.state]
  const outcome = resolveFleetWorkerOutcome({ workerState: worker.state, dispatchStatus: dispatch })
  const liveness: FleetLiveness = exited
    ? { verdict: 'exited', source: 'resource_release' }
    : worker.state === 'stop_unknown'
      ? { verdict: 'unverifiable', reason: 'host_indeterminate' }
      : { verdict: 'live', observedAt: Date.now(), source: 'agent_status' }
  return {
    id: worker.dispatchId,
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    runId: EVAL_RUN_ID,
    role: 'worker',
    parent: null,
    provider: typeof worker.agent === 'string' ? { id: worker.agent, model: null } : null,
    host: worker.server ? { kind: 'remote', id: worker.server } : { kind: 'local', id: 'local' },
    workspace: { id: worker.worktreeId, kind: 'folder_or_worktree' },
    stage: {
      worker: worker.state,
      dispatch,
      detail: worker.state === 'stop_unknown' ? 'stop_outcome_unknown' : null,
      activity: worker.state === 'ready' ? 'working' : 'unknown'
    },
    outcome,
    liveness,
    evidence: { durable: true, liveStatus: 'unavailable', lastObservedAt: null },
    resource: {
      state: worker.terminal === 'released' ? 'released' : 'owned',
      id: worker.terminalHandle,
      ownerDispatchId: worker.dispatchId,
      releaseState: worker.terminal,
      terminalState: worker.terminal
    },
    nextAction: { kind: 'none', argv: [] },
    attention: projectOrchestrationFleetAttention({ isRoot: false, outcome, liveness })
  }
}

/** `orchestration.workerList`, in the shape the CLI's list views read. */
export function listed(workers: readonly StandInWorker[]): WorkerListResult {
  const counts: Record<string, number> = {}
  for (const worker of workers) {
    counts[worker.terminal] = (counts[worker.terminal] ?? 0) + 1
  }
  return {
    workers: workers.map(listedWorker),
    counts,
    page: { hasMore: false, nextCursor: null, total: workers.length }
  }
}

function listedWorker(worker: StandInWorker): WorkerListResult['workers'][number] {
  return {
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    runId: EVAL_RUN_ID,
    workerState: worker.state,
    dispatchStatus: DISPATCH_STATUS[worker.state],
    agentTerminalHandle: worker.terminalHandle,
    terminalState: worker.terminal,
    projection: projection(worker)
  }
}

export function shown(worker: StandInWorker): WorkerShowResult {
  const stage = projection(worker).stage
  return {
    dispatch: {
      id: worker.dispatchId,
      runId: EVAL_RUN_ID,
      taskId: worker.taskId,
      status: stage.dispatch,
      followUpOf: worker.followUpOf ?? null
    },
    worker: {
      dispatchId: worker.dispatchId,
      state: worker.state,
      stage: stage.detail ?? worker.state,
      worktreeId: worker.worktreeId,
      agentTerminalHandle: worker.terminalHandle,
      lastError: worker.lastError ?? null
    },
    projection: projection(worker),
    autoReleaseAt: null
  }
}
