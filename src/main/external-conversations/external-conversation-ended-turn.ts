import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import type { AgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import {
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionFailure,
  structuredAgentSessionTurnAssistantMessage
} from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { ConversationChat } from './external-conversation-chat'
import {
  endedChatTurnRow,
  latestTurnOpener,
  readEndedChatTurnOpener
} from './external-conversation-turn-opener'

// A chat's ended turn, read from its journal as of the turn's end.

export type EndedChatTurn = {
  opener?: AgentJournalRenderItem | null
  lastAssistantMessage?: string
  /** Why the turn failed, as the chat's typed failure says, when it did. */
  failure?: AgentSessionFailureFact
  /** The turn's opening message by position, for when `opener` can't be resolved. */
  latestOpener?: AgentJournalRenderItem | null
  /** The turn row's journal key, the connector deliveries it answered, and the root prose written
   *  inside it (design item 125). */
  turnItemId?: string
  stamps?: AgentJournalConnectorDelivery[]
  turnProse?: string
}

export async function endedTurn(
  chat: ConversationChat,
  sessionId: string,
  turnId: string,
  cursor?: AgentJournalCursor
): Promise<EndedChatTurn> {
  // The ended turn (or its refused send's row) through the head, with the sends that place it: a
  // tail page can end before the message, and the whole journal can be hundreds of MB.
  const journal = cursor
    ? await chat
        .journalReads(sessionId)
        .then((reads) =>
          reads.operationWindow({
            turnIds: [turnId],
            itemIds: [turnId],
            anchorsOnly: true,
            withoutToolOutput: true
          })
        )
        .then(({ snapshot }) => snapshot)
        .catch(() => null)
    : null
  if (
    !cursor ||
    !journal ||
    journal.cursor.epoch !== cursor.epoch ||
    journal.cursor.sequence < cursor.sequence
  ) {
    return {}
  }
  const items = journal.items.filter((item) => item.sequence <= cursor.sequence)
  const opener = await readEndedChatTurnOpener(() => chat.journalReads(sessionId), items, turnId)
  const lastAssistantMessage = latestStructuredAgentSessionAssistantMessage(items)
  const failure = latestStructuredAgentSessionFailure(items, journal.submissions)
  return {
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(failure ? { failure } : {}),
    latestOpener: latestTurnOpener(items),
    ...(opener === undefined ? {} : { opener }),
    ...outboxTurn(items, journal.submissions, opener, turnId)
  }
}

/** Whom an ended turn acts for, from its own rows by index (STA-16396 moves the other ends here).
 *  Empty, so nothing is proven, while the journal hasn't reached the turn's end or can't say. */
export async function endedTurnAttribution(
  chat: ConversationChat,
  sessionId: string,
  turnId: string,
  cursor?: AgentJournalCursor
): Promise<Pick<EndedChatTurn, 'opener' | 'stamps'>> {
  const read = cursor
    ? await chat
        .journalReads(sessionId)
        .then((reads) => reads.turnAttribution(turnId, cursor.sequence))
        .catch(() => null)
    : null
  if (
    !cursor ||
    !read?.stamps ||
    read.cursor.epoch !== cursor.epoch ||
    read.cursor.sequence < cursor.sequence
  ) {
    return {}
  }
  return { opener: read.opener, stamps: read.stamps }
}

/** What the reply outbox reads of the turn: its row's journal key, the deliveries it answered, and
 *  the prose written inside it. */
function outboxTurn(
  items: readonly AgentJournalRenderItem[],
  submissions: AgentJournalSnapshot['submissions'],
  opener: AgentJournalRenderItem | null | undefined,
  turnId: string
): Pick<EndedChatTurn, 'turnItemId' | 'stamps' | 'turnProse'> {
  const turnItemId = endedChatTurnRow(items, turnId)?.itemId
  return turnItemId
    ? {
        turnItemId,
        stamps: connectorReplyTurnStamps({ items, submissions }, opener, turnItemId),
        turnProse: structuredAgentSessionTurnAssistantMessage(items, turnItemId)
      }
    : {}
}
