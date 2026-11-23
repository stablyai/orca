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
  /** On a turn the agent opened itself: the runs (by the call that started each) that woke it (empty
   *  when nothing named the wake-up), whether someone steered a message into it, and each of those
   *  runs' launches as the turns that launched them recorded them (none found: not within the window). */
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
          launches:
            wokenBy.length > 0 && lifecycle.startedAt !== undefined
              ? await launchesOf(chat, sessionId, cursor, lifecycle.startedAt, wokenBy)
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

/** How far back a wake-up's launches are looked for: a run launched earlier stays in Orca. */
export const WAKE_LAUNCH_WINDOW_MS = 24 * 60 * 60 * 1000

/** The launches of `runs` that turns of the last day recorded, from the messages and turn rows only
 *  (no tool output), as of the wake-up's end; none when the journal can't say. */
async function launchesOf(
  chat: ConversationChat,
  sessionId: string,
  cursor: AgentJournalCursor,
  wokeAt: number,
  runs: readonly string[]
): Promise<EndedTurnLaunch[]> {
  const journal = await chat
    .journalReads(sessionId)
    .then((reads) =>
      reads.operationWindow({
        observedSince: wokeAt - WAKE_LAUNCH_WINDOW_MS,
        anchorsOnly: true,
        withoutToolOutput: true,
        turnShape: true
      })
    )
    .then(({ snapshot }) => snapshot)
    .catch(() => null)
  if (!journal || journal.cursor.epoch !== cursor.epoch) {
    return []
  }
  const items = journal.items.filter((item) => item.sequence <= cursor.sequence)
  const byItemId = new Map(items.map((item) => [item.itemId, item]))
  const named = new Set(runs)
  return items.flatMap((item) =>
    item.body.kind === 'turn'
      ? (readAgentJournalTurn(item.body)?.launches ?? [])
          .filter((launch) => named.has(launch.run))
          .map((launch) => ({
            run: launch.run,
            sends: launch.sends.map((send) => sentFrom(byItemId, send)),
            runs: launch.runs
          }))
      : []
  )
}

/** The conversation whose delivery a send was, as written on its message when delivered. A
 *  delivery the owner edited (it loses its connector origin) is the owner's own. */
function sentFrom(
  items: ReadonlyMap<string, AgentJournalRenderItem>,
  send: string
): EndedTurnLaunch['sends'][number] {
  const body = items.get(agentJournalSubmissionKey(send))?.body
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
