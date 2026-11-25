import type { AGENT_CONVERSATION_REFUSAL_CODES as CODES } from '../../../shared/agent-conversations/agent-conversation-contracts'

/** A refusal an `orca agent` command shows as is; `code` is for `--json` callers. */
export class AgentConversationRefusal extends Error {
  constructor(
    readonly code: (typeof CODES)[keyof typeof CODES],
    message: string
  ) {
    super(message)
    this.name = 'AgentConversationRefusal'
  }
}
