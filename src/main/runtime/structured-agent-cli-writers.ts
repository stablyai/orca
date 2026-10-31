import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { namesCliConversation } from '../../shared/structured-agent-cli-conversation-adoption'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'

export type CliWriterHost = {
  rows: () => AgentStatusIpcPayload[]
  observation: (row: AgentStatusIpcPayload) => CliWriterObservation | null
}

/** Only a live holder in the execution host's status store blocks continuation. */
export async function assertCliConversationWritersExited(
  host: CliWriterHost,
  agent: StructuredAgentId,
  providerSessionId: string
): Promise<void> {
  for (const row of host.rows()) {
    if (
      row.structuredHost ||
      row.agentPresence?.ended ||
      !namesCliConversation(row, agent, providerSessionId)
    ) {
      continue
    }
    const observation = host.observation(row)
    const presence = await observation?.presence()
    if (
      observation?.current() &&
      (presence === 'live' || (presence === null && !row.providerSessionOnly))
    ) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  }
}
