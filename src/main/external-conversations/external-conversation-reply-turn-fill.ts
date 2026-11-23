import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnReply } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { structuredAgentSessionTurnFailure } from '../../shared/agent-session/requests/structured-agent-session-turn-failure'
import { connectorFailure } from './external-conversation-failure'
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import type { ReplyRecoveryChat } from './external-conversation-reply-recovery'
import { turnVerdictOf } from './external-conversation-reply-evidence'
import { readEndedChatTurnOpener } from './external-conversation-turn-opener'

/** Fills the rows a turn with a verdict answered; returns those one without a verdict claims
 *  (unresolved), or a cut turn's (cut). */
export async function fillRecoveredTurn(
  chat: Pick<ReplyRecoveryChat, 'journalReads'>,
  sessionId: string,
  snapshot: AgentJournalSnapshot,
  turn: AgentJournalRenderItem,
  deps: {
    fillTurn: ConversationReplyFill
    isBot: (sessionId: string) => boolean
    agentOf: (sessionId: string) => string
  }
): Promise<{ kind: 'unresolved' | 'cut'; stamps: AgentJournalConnectorDelivery[] }> {
  const outcome = readAgentJournalTurnOutcome(readAgentJournalTurn(turn.body))
  const items = snapshot.items.filter((item) => item.sequence <= turn.sequence)
  const opener = await readEndedChatTurnOpener(
    () => chat.journalReads(sessionId),
    items,
    turn.itemId
  )
  const stamps = connectorReplyTurnStamps(snapshot, opener, turn.itemId)
  if (!outcome) {
    // Running or unverifiable: its requests stay unfilled and watched (O3). Cut by a restart or
    // an exit: owed to a continuation until this start's continuations settled.
    const verdict = turnVerdictOf(turn)
    return {
      kind: verdict === 'interruption' || verdict === 'unconfirmed' ? 'cut' : 'unresolved',
      stamps
    }
  }
  if (stamps.length > 0) {
    await deps.fillTurn({
      sessionId,
      turnItemId: turn.itemId,
      stamps,
      ...(opener ? { openerItemId: opener.itemId } : {}),
      outcome,
      ...structuredAgentSessionTurnReply(snapshot.items, turn.itemId),
      bot: deps.isBot(sessionId),
      links: [],
      ...(outcome === 'failure'
        ? {
            failure: connectorFailure(
              structuredAgentSessionTurnFailure(snapshot.items, turn.itemId),
              deps.agentOf(sessionId)
            )
          }
        : {})
    })
  }
  return { kind: 'unresolved', stamps: [] }
}
