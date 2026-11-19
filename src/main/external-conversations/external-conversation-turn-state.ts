import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusState } from '../../shared/agent-status/contracts/agent-status-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type {
  ConnectorActsFor,
  ConnectorTurnFor,
  ConnectorTurnOrigin
} from '../../shared/connectors/connector-cloud-contract'

/** The lead agent's own state; background work can keep the combined row working across turns. */
export function leadOf(row: AgentStatusIpcPayload): {
  state: AgentStatusState
  stateStartedAt: number
} {
  return row.mainAgent ?? row
}

/**
 * The one owner of whether a chat's running turn is its conversation's: a delivery started or joined
 * it, or mail finishing its ask (isConversationReport) opened it. A bot's Chat is also its
 * owner's, so what wakes it stays in Orca. Any other turn, begun in Orca, reaches the thread in no way.
 */
export function conversationOwnsTurn(
  link: Pick<ExternalConversationLink, 'sessionId' | 'bot'>,
  facts: {
    delivered: (sessionId: string) => boolean
    reported: (sessionId: string) => boolean
  }
): boolean {
  return (
    facts.delivered(link.sessionId) ||
    (link.bot?.kind !== 'bot-chat' && facts.reported(link.sessionId))
  )
}

/** A chat's turn is its lead's; background work alone is no turn. */
export function conversationWorking(row: AgentStatusIpcPayload | null): boolean {
  return row ? leadOf(row).state === 'working' : false
}

/** Whom an ended chat turn acts for, as its final post tells Orca Cloud: none for a delivery's turn,
 *  whose person the cloud reads from its own record; else the owner only when Orca recorded that the
 *  conversation acts for them (bot-turn-for.ts says why). */
export function chatTurnFor(
  origin: ConnectorTurnOrigin,
  actsFor: ConnectorActsFor | undefined
): { turnFor?: ConnectorTurnFor } {
  return origin === 'delivery' ? {} : { turnFor: actsFor === 'owner' ? 'owner' : 'someone_else' }
}
