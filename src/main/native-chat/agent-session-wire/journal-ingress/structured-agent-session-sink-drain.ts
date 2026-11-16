import type * as events from './structured-agent-session-event-sink'
export const MAX_PRE_CONTROL_OPERATIONS = 1_024
export const MAX_PRE_CONTROL_BYTES = 32 * 1024 * 1024

export function exceedsStartupCapacity(
  controlled: boolean,
  bytes: number,
  operations: number
): boolean {
  return !controlled && (bytes > MAX_PRE_CONTROL_BYTES || operations > MAX_PRE_CONTROL_OPERATIONS)
}

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: events.StructuredAgentSessionSinkBarrier) => void
}

export function settleSinkDrainWaiters(
  waiters: StructuredAgentSessionDrainWaiter[],
  through: number,
  result: events.StructuredAgentSessionSinkBarrier
): void {
  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]
    if (waiter && waiter.through <= through) {
      waiters.splice(index, 1)
      waiter.resolve(result)
    }
  }
}

export type StructuredAgentSessionSinkQueueDeps = {
  watermarks: events.StructuredAgentSessionSinkWatermarks
  onFailed?: (error: unknown) => void
  onWorkChanged?: () => void
  readingControl?: events.StructuredAgentSessionReadingControl
  onBackpressureChange?: (
    backpressured: boolean,
    state: events.StructuredAgentSessionSinkState
  ) => void
}
