import { OrchestrationError } from './orchestration-error'
import type { WorkerDispatchState } from './types'

// Why: an unknown start or stop is unverifiable, not exited (docs/reference/ssh-execution-boundary.md),
// so the worker's own report outranks it, locally and on a connected server.
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
