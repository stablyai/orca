import type {
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

export type Admitted = StructuredAgentSessionSinkOperation & { superseded?: boolean }

export const MAX_PRE_CONTROL_OPERATIONS = 1_024
export const MAX_PRE_CONTROL_BYTES = 32 * 1024 * 1024

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: StructuredAgentSessionSinkBarrier) => void
}

export function runNow(run: () => Promise<unknown> | void): Promise<unknown> {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}

export function settleSinkDrainWaiters(
  waiters: StructuredAgentSessionDrainWaiter[],
  through: number,
  result: StructuredAgentSessionSinkBarrier
): void {
  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]
    if (waiter && waiter.through <= through) {
      waiters.splice(index, 1)
      waiter.resolve(result)
    }
  }
}
