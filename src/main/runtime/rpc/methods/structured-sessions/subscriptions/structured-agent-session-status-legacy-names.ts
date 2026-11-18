import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_RECORD_NAMES_CLIENT_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/agent-session-record-names-capability'
import type { AgentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { savedStructuredAgentSessionStatus } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-saved-status'
import type { RpcContext } from '../../../core'

/**
 * A paired client from before the naming snapshot reads a closed chat's name only from a status
 * row, and the host no longer keeps those rows. Rebuild them from the records, for that client only.
 */
export function legacyClosedChatNameRows(
  ctx: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  shown: readonly AgentSessionStatusSummary[],
  records: readonly AgentSessionConversationView[]
): AgentSessionStatusSummary[] {
  if (
    ctx.clientKind !== 'runtime' ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_RECORD_NAMES_CLIENT_CAPABILITY)
  ) {
    return []
  }
  const present = new Set(shown.map((summary) => summary.sessionId))
  return records.flatMap((record) =>
    record.conversationName && !present.has(record.sessionId)
      ? [savedStructuredAgentSessionStatus(record)]
      : []
  )
}
