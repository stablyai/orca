// Which provider request ran out of time, set where the deadline fired so a failed start can say
// so without reading it back out of an error message.

import {
  readAgentSessionRequestTimeout,
  type AgentSessionRequestTimeout
} from '../../shared/agent-session-request-timeout'

/** Marks the error a provider request's own deadline rejected with. */
export function withProviderRequestTimeout<TError extends Error>(
  error: TError,
  timeout: AgentSessionRequestTimeout
): TError {
  return Object.assign(error, { providerRequestTimeout: timeout })
}

/** The timed-out request an error carries. Follows `cause` and aggregated errors, since the
 *  acquisition errors wrap what the adapter threw. */
export function providerRequestTimeoutOf(
  error: unknown,
  depth = 0
): AgentSessionRequestTimeout | undefined {
  if (depth >= 6 || !(error instanceof Error)) {
    return undefined
  }
  if ('providerRequestTimeout' in error) {
    const timeout = readAgentSessionRequestTimeout(error.providerRequestTimeout)
    if (timeout) {
      return timeout
    }
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = providerRequestTimeoutOf(inner, depth + 1)
      if (found) {
        return found
      }
    }
  }
  return providerRequestTimeoutOf(error.cause, depth + 1)
}
