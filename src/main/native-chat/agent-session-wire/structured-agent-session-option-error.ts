import { AGENT_SESSION_FAILURE_COPY } from '../../../shared/agent-session-failure-copy'

/** Option validation failed before the provider session was mutated. */
export class AgentSessionOptionRejectedError extends Error {
  constructor(
    cause: unknown,
    /** providerStarting means the value is valid but cannot be applied yet. */
    readonly refusalReason: 'optionRejected' | 'providerStarting' = 'optionRejected'
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionOptionRejectedError'
  }
}

export function isAgentSessionOptionRejectedError(
  error: unknown
): error is AgentSessionOptionRejectedError {
  return error instanceof Error && error.name === 'AgentSessionOptionRejectedError'
}

export class ClaudeEffortValidationError extends AgentSessionOptionRejectedError {
  constructor() {
    super(AGENT_SESSION_FAILURE_COPY.claudeEffortInvalid)
  }
}
