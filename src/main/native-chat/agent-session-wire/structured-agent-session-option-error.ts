/** Option validation failed before the provider session was mutated. */
export class AgentSessionOptionRejectedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionOptionRejectedError'
  }
}

export function isAgentSessionOptionRejectedError(
  error: unknown
): error is AgentSessionOptionRejectedError {
  return error instanceof Error && error.name === 'AgentSessionOptionRejectedError'
}
