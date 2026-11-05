import { OrchestrationError } from './orchestration-error'
import { AGENT_PROMPT_STALLED_ERROR } from '../terminal/input/agent-prompt-submission-verification'
import type { DispatchContextRow, TaskRow, WorkerDispatchState } from './types'

// Unknown start/stop cannot prove exit; the worker's report outranks uncertainty (docs/reference/ssh-execution-boundary.md).
export const UNPROVEN_WORKER_STATES = [
  'start_unknown',
  'stop_unknown'
] as const satisfies readonly WorkerDispatchState[]

export const SETTLEABLE_WORKER_STATES = [
  'ready',
  ...UNPROVEN_WORKER_STATES
] as const satisfies readonly WorkerDispatchState[]

export function isWorkerStateIn(
  states: readonly WorkerDispatchState[],
  state: WorkerDispatchState | undefined
): boolean {
  return state !== undefined && states.includes(state)
}

export type WorkerReportRefusal = {
  code: 'dispatch_inactive' | 'worker_identity_changed'
  reason: string
}

/** The one admission rule for a worker's lifecycle report or question: only a stop in flight mutes it. */
export function workerReportRefusal(args: {
  dispatchId: string
  from: string
  workerState: WorkerDispatchState | undefined
  processCurrent: boolean
}): WorkerReportRefusal | null {
  if (args.workerState === 'stopping') {
    return {
      code: 'dispatch_inactive',
      reason: `Dispatch ${args.dispatchId} is stopping; its worker cannot report until worker-stop settles.`
    }
  }
  if (!args.processCurrent) {
    return {
      code: 'worker_identity_changed',
      reason: `${args.from} is not the exact process that owns Dispatch ${args.dispatchId}.`
    }
  }
  return null
}

export function assertWorkerCanReport(args: Parameters<typeof workerReportRefusal>[0]): void {
  const refusal = workerReportRefusal(args)
  if (refusal) {
    throw new OrchestrationError(refusal.code, refusal.reason)
  }
}

/** A first-hand worker report can correct an unobserved prompt failure, even after circuit break. */
export function reportCorrectsUnobservedPrompt(
  dispatch: Pick<DispatchContextRow, 'status' | 'last_failure'>,
  task: Pick<TaskRow, 'status'>
): boolean {
  return (
    (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') &&
    dispatch.last_failure === AGENT_PROMPT_STALLED_ERROR &&
    task.status === 'failed'
  )
}
