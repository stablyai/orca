export class AgentPromptDeliveryUnknownError extends Error {
  readonly code = 'operation_unknown'
  readonly data: Readonly<{ operation: 'agent_prompt_delivery'; reason: string }>

  constructor(reason: string) {
    super(`Agent prompt delivery outcome is unknown: ${reason}`)
    this.name = 'AgentPromptDeliveryUnknownError'
    this.data = { operation: 'agent_prompt_delivery', reason }
  }
}

export function agentPromptDeliveryBecameUnknown(error: unknown): AgentPromptDeliveryUnknownError {
  if (error instanceof AgentPromptDeliveryUnknownError) {
    return error
  }
  return new AgentPromptDeliveryUnknownError(error instanceof Error ? error.message : String(error))
}

export function isAgentPromptDeliveryUnknownError(
  error: unknown
): error is AgentPromptDeliveryUnknownError {
  return error instanceof AgentPromptDeliveryUnknownError
}
