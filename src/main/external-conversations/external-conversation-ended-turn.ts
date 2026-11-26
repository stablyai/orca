import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  connectorReplyStampsOf,
  type ConnectorReplyStamp
} from '../../shared/agent-session/journal/journal-connector-reply-turn'
import type { AgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import {
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionFailure
} from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { structuredAgentSessionTurnReply } from '../../shared/agent-session/requests/structured-agent-session-turn-reply'
import type { ConversationChat } from './external-conversation-chat'
import {
  endedChatTurnRow,
  latestTurnOpener,
  readEndedChatTurnOpener
} from './external-conversation-turn-opener'
import { journalTurnAnsweredMessages } from '../../shared/agent-session/journal/journal-turn-answered-messages'

// A chat's ended turn, read from its journal as of the turn's end.

export type EndedChatTurn = {
  opener?: AgentJournalRenderItem | null
  lastAssistantMessage?: string
  /** Why the turn failed, as the chat's typed failure says, when it did. */
  failure?: AgentSessionFailureFact
  /** The turn's opening message by position, for when `opener` can't be resolved. */
  latestOpener?: AgentJournalRenderItem | null
  /** The turn row's journal key, the connector deliveries it answered, and the root prose written
   *  inside it (design item 125), and whether a tool call inside it may have acted. */
  turnItemId?: string
  stamps?: ConnectorReplyStamp[]
  turnProse?: string
  /** A bot's answer in it: its prose after its last tool call (structuredAgentSessionTurnReply). */
  turnBotProse?: string
  turnToolsRan?: boolean
  /** The turn answered a message besides its opener (a steer, a joined bot request): no one asker. */
  turnAnsweredOthers?: boolean
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
): Pick<
  EndedChatTurn,
  'turnItemId' | 'stamps' | 'turnProse' | 'turnBotProse' | 'turnToolsRan' | 'turnAnsweredOthers'
> {
  const turnItemId = endedChatTurnRow(items, turnId)?.itemId
  if (!turnItemId) {
    return {}
  }
  const { prose, botProse, toolsRan } = structuredAgentSessionTurnReply(items, turnItemId)
  const answered = journalTurnAnsweredMessages({ items, submissions }, opener, turnItemId)
  return {
    turnItemId,
    stamps: connectorReplyStampsOf(opener, answered),
    turnProse: prose,
    turnBotProse: botProse,
    turnToolsRan: toolsRan,
    turnAnsweredOthers: answered.length > 1
  }
}

/** The message that opened a turn, read from its own rows; undefined when they can't be read. */
export async function turnOpenerOf(
  chat: Pick<ConversationChat, 'journalReads'>,
  sessionId: string,
  turnId: string
): Promise<AgentJournalRenderItem | null | undefined> {
  const reads = await chat.journalReads(sessionId).catch(() => null)
  const window = await reads
    ?.operationWindow({
      turnIds: [turnId],
      itemIds: [turnId],
      anchorsOnly: true,
      withoutToolOutput: true
    })
    .catch(() => null)
  return reads && window
    ? readEndedChatTurnOpener(async () => reads, window.snapshot.items, turnId)
    : undefined
}
