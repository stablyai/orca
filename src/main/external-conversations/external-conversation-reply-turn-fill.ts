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
import { structuredAgentSessionTurnReply } from '../../shared/agent-session/requests/structured-agent-session-turn-reply'
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
    /** Whether the recovery pass filling is still current (EndedTurnReplies.current). */
    current?: () => boolean
  }
): Promise<{ kind: 'unresolved' | 'cut'; stamps: AgentJournalConnectorDelivery[] }> {
  const record = readAgentJournalTurn(turn.body)
  const outcome = readAgentJournalTurnOutcome(record)
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
      ...(record?.startedAt ? { postsSince: record.startedAt } : {}),
      ...(record?.completedAt ? { postsUntil: record.completedAt } : {}),
      ...turnReplyOf(snapshot.items, turn.itemId, deps.isBot(sessionId)),
      links: [],
      // Recovery fills it after the fact: judged by when the turn ended (REPLY_FRESH_MS).
      recovered: { endedAt: readAgentJournalTurn(turn.body)?.completedAt ?? turn.observedAt },
      ...(deps.current ? { current: deps.current } : {}),
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

/** A recovered turn's words, as the live end reads them for a bot or another chat. */
function turnReplyOf(items: AgentJournalSnapshot['items'], turnItemId: string, bot: boolean) {
  const { prose, botProse, toolsRan } = structuredAgentSessionTurnReply(items, turnItemId)
  return bot ? { prose: botProse, earlierProse: prose, toolsRan, bot } : { prose, toolsRan, bot }
}
