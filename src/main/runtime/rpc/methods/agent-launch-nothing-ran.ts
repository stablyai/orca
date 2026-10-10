import type { RpcFailure } from '../core'
import { AGENT_LAUNCH_NOTHING_RAN_DATA } from '../../../../shared/agent-launch-nothing-ran'

/**
 * What a launch that proved it ran nothing throws to its caller: its cause, answered on the wire
 * exactly as the cause would be, with the fact beside it. A wrapper rather than a mark on the
 * cause, because one spawn failure can reach two launches with different verdicts.
 */
export class AgentLaunchNothingRanError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentLaunchNothingRanError'
  }
}

function isDataRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

/** The cause's own failure, with "nothing ran" beside any data it carries (a refused journal open
 *  carries its refusal). */
export function withAgentLaunchNothingRan(failure: RpcFailure): RpcFailure {
  const { data } = failure.error
  const carried = data === undefined ? {} : isDataRecord(data) ? data : null
  return carried
    ? {
        ...failure,
        error: { ...failure.error, data: { ...carried, ...AGENT_LAUNCH_NOTHING_RAN_DATA } }
      }
    : failure
}
