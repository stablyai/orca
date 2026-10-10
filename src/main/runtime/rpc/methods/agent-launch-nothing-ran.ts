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

function isDataRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

/** Adds the "nothing ran" data to a launch failure the host marked, beside any data it carries
 *  (a refused journal open carries its refusal). */
export function withAgentLaunchNothingRan(failure: RpcFailure, error: unknown): RpcFailure {
  if (typeof error !== 'object' || error === null || !nothingRanErrors.has(error)) {
    return failure
  }
  const { data } = failure.error
  const carried = data === undefined ? {} : isDataRecord(data) ? data : null
  return carried
    ? {
        ...failure,
        error: { ...failure.error, data: { ...carried, ...AGENT_LAUNCH_NOTHING_RAN_DATA } }
      }
    : failure
}
