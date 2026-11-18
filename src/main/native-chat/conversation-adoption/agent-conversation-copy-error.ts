import {
  AgentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRefusalDetailsByCode } from '../../../shared/agent-session/failures/agent-session-refusal-details'

/** Only copy errors authored here may pass through the host's generic provider failure. */
export class AgentConversationCopyError extends Error {}

export class AgentConversationCopyStartError extends AgentConversationCopyError {}

export function agentConversationCopyRefusal<C extends AgentSessionWireRefusalCode>(
  code: C,
  details: NoInfer<AgentSessionRefusalDetailsByCode[C]>,
  message: string
): AgentSessionRefusalError {
  return new AgentSessionRefusalError(refuse(code, details, message), {
    cause: new AgentConversationCopyError(message)
  })
}
