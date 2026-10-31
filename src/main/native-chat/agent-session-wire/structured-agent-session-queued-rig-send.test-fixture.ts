import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'

export type RigSendOptions = {
  internal?: true
  from?: AgentMessageSource
  carried?: Readonly<Record<string, string>>
}
