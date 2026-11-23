import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  connectorReplyTurnStamps,
  type ConnectorReplyStamp
} from '../../shared/agent-session/journal/journal-connector-reply-turn'
import type { AgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import {
  isSelfStartedTurnRow,
  latestStructuredAgentSessionAssistantMessage,
  latestStructuredAgentSessionFailure,
  steeredInto,
  structuredAgentSessionTurnAssistantMessage
} from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { ConversationChat } from './external-conversation-chat'
import {
  endedChatTurnRow,
  latestTurnOpener,
  readEndedChatTurnOpener
} from './external-conversation-turn-opener'

// A chat's ended turn, read from its journal as of the turn's end.

/** A background run the turn's root agent launched, with the inputs it had taken by then: where each
 *  send came from (null: typed in Orca, or not found), and the runs that woke it. */
export type EndedTurnLaunch = {
  run: string
  sends: ({ source: string; externalId: string } | null)[]
  runs: string[]
}

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
  stamps?: ConnectorReplyStamp[]
  turnProse?: string
  /** On a turn the agent opened itself: the runs (by the call that started each) that woke it (empty when nothing named
   *  the wake-up), and whether someone steered a message into it. */
  wake?: { wokenBy: string[]; steered: boolean }
  launches?: EndedTurnLaunch[]
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
  const row = endedChatTurnRow(items, turnId)
  const lifecycle = row && readAgentJournalTurn(row.body)
  const wake =
    row && lifecycle && isSelfStartedTurnRow(row, () => false)
      ? {
          wokenBy: lifecycle.wokenBy ?? [],
          steered: steeredInto(journal.submissions, row.itemId)
        }
      : undefined
  const launches = lifecycle?.launches?.map((launch) => ({
    run: launch.run,
    sends: launch.sends.map((send) => sentFrom(items, opener, send)),
    runs: launch.runs
  }))
  return {
    ...(wake ? { wake } : {}),
    ...(launches ? { launches } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(failure ? { failure } : {}),
    latestOpener: latestTurnOpener(items),
    ...(opener === undefined ? {} : { opener }),
    ...outboxTurn(items, journal.submissions, opener, turnId)
  }
}

/** The conversation whose delivery a send was, as written on its message when delivered. */
function sentFrom(
  items: readonly AgentJournalRenderItem[],
  opener: AgentJournalRenderItem | null | undefined,
  send: string
): EndedTurnLaunch['sends'][number] {
  const key = agentJournalSubmissionKey(send)
  const body = (opener?.itemId === key ? opener : items.find((item) => item.itemId === key))?.body
  return body?.kind === 'message'
    ? (body.connectorConversation ?? body.connectorDelivery?.conversation ?? null)
    : null
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
