import type { RpcFailure } from '../core'
import { AGENT_LAUNCH_NOTHING_RAN_DATA } from '../../../../shared/agent-launch-nothing-ran'

// Keyed by the thrown error itself, so its type and code reach the wire exactly as before.
const nothingRanErrors = new WeakSet<object>()

/** The launch that threw this ran nothing. */
export function markAgentLaunchNothingRan(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    nothingRanErrors.add(error)
  }
}

/** Adds the "nothing ran" data to a launch failure the host marked, unless it carries data already. */
export function withAgentLaunchNothingRan(failure: RpcFailure, error: unknown): RpcFailure {
  return failure.error.data === undefined &&
    typeof error === 'object' &&
    error !== null &&
    nothingRanErrors.has(error)
    ? { ...failure, error: { ...failure.error, data: AGENT_LAUNCH_NOTHING_RAN_DATA } }
    : failure
}
