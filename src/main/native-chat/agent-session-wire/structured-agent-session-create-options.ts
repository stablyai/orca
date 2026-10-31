import type { StructuredAgentSessionFirstMessage } from '../../../shared/structured-agent-session-create'
import type { reserveRequestFor } from './structured-agent-session-attach'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { SwitchStoppedCliTurn } from './structured-agent-session-switch-import'

export type StructuredAgentSessionCreateOptions = {
  check?: () => void
  firstMessage?: StructuredAgentSessionFirstMessage
  hostLaunchDirectory?: string
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Publish after durable creation, before agent delivery starts. */
  publishTab?: () => Promise<void>
  /** The CLI turn a switch stopped with proof before this adoption. */
  switchStop?: SwitchStoppedCliTurn
}

/** Opening messages retain creation-time model/effort choices like later sends. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
