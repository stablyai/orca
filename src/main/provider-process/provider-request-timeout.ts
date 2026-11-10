// Preserve timeout metadata across acquisition error wrapping without parsing messages.

import {
  readAgentSessionRequestTimeout,
  type AgentSessionRequestTimeout
} from '../../shared/agent-session/agent-session-request-timeout'
import { findInErrorChain } from './provider-error-chain'

export function withProviderRequestTimeout<TError extends Error>(
  error: TError,
  timeout: AgentSessionRequestTimeout
): TError {
  return Object.assign(error, { providerRequestTimeout: timeout })
}

export function providerRequestTimeoutOf(error: unknown): AgentSessionRequestTimeout | undefined {
  return findInErrorChain(error, (inner) =>
    'providerRequestTimeout' in inner
      ? readAgentSessionRequestTimeout(inner.providerRequestTimeout)
      : undefined
  )
}
