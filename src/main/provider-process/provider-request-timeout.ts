// Which provider request ran out of time, set where the deadline fired so a failed start can say
// so without reading it back out of an error message.

import {
  readAgentSessionRequestTimeout,
  type AgentSessionRequestTimeout
} from '../../shared/agent-session-request-timeout'
import { findInErrorChain } from './provider-error-chain'

/** Marks the error a provider request's own deadline rejected with. */
export function withProviderRequestTimeout<TError extends Error>(
  error: TError,
  timeout: AgentSessionRequestTimeout
): TError {
  return Object.assign(error, { providerRequestTimeout: timeout })
}

/** The timed-out request an error's chain carries. */
export function providerRequestTimeoutOf(error: unknown): AgentSessionRequestTimeout | undefined {
  return findInErrorChain(error, (inner) =>
    'providerRequestTimeout' in inner
      ? readAgentSessionRequestTimeout(inner.providerRequestTimeout)
      : undefined
  )
}
