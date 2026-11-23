import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
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
  /** On a turn the agent opened itself: the runs (by the call that started each) that woke it (empty
   *  when nothing named the wake-up), whether someone steered a message into it, and each of those
   *  runs' launches as the turns that launched them recorded them (none found: not recorded, or
   *  gone). */
  wake?: { wokenBy: string[]; steered: boolean; launches: EndedTurnLaunch[] }
  /** When the turn's row says it began, for a watch that never saw it start. */
  startedAt?: number
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
  const failure = latestStructuredAgentSessionFailure(items, journal.submissions)
  const row = endedChatTurnRow(items, turnId)
  const lifecycle = row && readAgentJournalTurn(row.body)
  const wokenBy = lifecycle?.wokenBy ?? []
  const wake =
    row && lifecycle && isSelfStartedTurnRow(row, () => false)
      ? {
          wokenBy,
          steered: steeredInto(journal.submissions, row.itemId),
          launches: lifecycle.wokeFrom?.length
            ? await launchesOf(chat, sessionId, cursor, lifecycle.wokeFrom)
            : []
        }
      : undefined
  // A wake-up has no message of its own to stop at: only its own prose is its answer.
  const lastAssistantMessage =
    wake && row
      ? structuredAgentSessionTurnAssistantMessage(items, row.itemId)
      : latestStructuredAgentSessionAssistantMessage(items)
  return {
    ...(wake ? { wake } : {}),
    ...(lifecycle?.startedAt === undefined ? {} : { startedAt: lifecycle.startedAt }),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(failure ? { failure } : {}),
    latestOpener: latestTurnOpener(items),
    ...(opener === undefined ? {} : { opener }),
    ...outboxTurn(items, journal.submissions, opener, turnId)
  }
}

/** The launch of each run the wake-up names, read from the row that recorded it, with each send's
 *  conversation: point reads only. None when the journal was reset since the wake-up's end; a row
 *  gone or hidden, or one whose launches don't name the run, gives none for that run. */
async function launchesOf(
  chat: ConversationChat,
  sessionId: string,
  cursor: AgentJournalCursor,
  wokeFrom: readonly { run: string; turn: string }[]
): Promise<EndedTurnLaunch[]> {
  const reads = await chat.journalReads(sessionId).catch(() => null)
  const now = await reads?.cursor().catch(() => null)
  if (!reads || now?.epoch !== cursor.epoch) {
    return []
  }
  const launches = await Promise.all(
    wokeFrom.map(async ({ run, turn }) => {
      const row = await reads.item(turn).catch(() => null)
      const launch = readAgentJournalTurn(row?.body)?.launches?.find((entry) => entry.run === run)
      if (!launch) {
        return []
      }
      const sends = await Promise.all(
        launch.sends.map((send) =>
          reads
            .submissionBody(send)
            .then(sentFrom)
            .catch(() => null)
        )
      )
      return [{ run, sends, runs: launch.runs }]
    })
  )
  return launches.flat()
}

/** The conversation whose delivery a send was, as written on its message when delivered. A
 *  delivery the owner edited (it loses its connector origin) is the owner's own. */
function sentFrom(body: AgentJournalMessageItem | null): EndedTurnLaunch['sends'][number] {
  if (body?.kind !== 'message') {
    return null
  }
  const delivered = body.origin === 'connector' ? body.connectorDelivery?.conversation : undefined
  return body.connectorConversation ?? delivered ?? null
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
