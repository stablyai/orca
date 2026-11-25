import { randomUUID } from 'node:crypto'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { connectorReplyTurnOutcome } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import { connectorPostAttempts } from './connector-post-attempts'
import {
  callerFor,
  chatPaneKey,
  chatIsIdle,
  envelope,
  type ConversationChat
} from './external-conversation-chat'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { EndedTurnReplies } from './external-conversation-reply-fill'

// A bot's Slack request whose turn succeeded with nothing written after its last tool call, and
// whose tools only read, is asked once more, in the same chat, before the thread is told there was
// no answer. A turn whose tools may have acted is never asked again. Only a live turn end asks; a
// turn found at boot isn't. The thread never sees the ask.

const RETRY_PROMPT = `Your last turn ended without a written answer. Write the answer now from what you already have, without calling any more tools; if you wrote it earlier in that turn, write it again. If nothing needs saying, answer exactly ${BOT_QUIET_MARKER}.`

/** How the ask's send went: accepted (the retry's turn fills its rows), refused (it never ran), or
 *  unknown (it may have). */
export type EmptyRetrySend = (
  sessionId: string,
  body: AgentJournalMessageItem,
  /** The empty turn: a chat whose newest turn is another by then has moved on. */
  turnItemId: string
) => Promise<'accepted' | 'refused' | 'unknown'>

export type EmptyTurnRetry = {
  /** Holds an empty turn's rows for its one retry and sends it; false fills them as they are. */
  hold: (turn: EndedTurnReplies, own: readonly JournalConnectorReplyRow[]) => Promise<boolean>
  /** The chat tried a post of its own during the live turn: its earlier words aren't its answer. */
  posted: (
    turn: Pick<EndedTurnReplies, 'sessionId' | 'turnStartedAt' | 'postsSince' | 'postsUntil'>
  ) => boolean
  /** A row held for a retry not yet sent: recovery leaves it. */
  sending: (row: Pick<JournalConnectorReplyRow, 'account' | 'deliveryId'>) => boolean
}

const keyOf = (row: Pick<JournalConnectorReplyRow, 'account' | 'deliveryId'>) =>
  `${row.account}\0${row.deliveryId}`

export function emptyTurnRetry(deps: {
  journal: () => ConnectorReplyCutJournal | null
  /** Whether the chat tried to post into Slack itself since `at` (ConnectorPostAttempts). */
  postedSince: (sessionId: string, at: number, until: number) => boolean
  send: EmptyRetrySend
  /** The ask is settled: recovery reads the rows again (a refused ask closes them as no answer). */
  settled: (sessionId: string) => void
}): EmptyTurnRetry {
  const sending = new Set<string>()
  // With no known start, no post can be pinned to this turn: an earlier turn's never counts.
  const posted = (
    turn: Pick<EndedTurnReplies, 'sessionId' | 'turnStartedAt' | 'postsSince' | 'postsUntil'>
  ) => {
    const from = turn.turnStartedAt ?? turn.postsSince
    return (
      from !== undefined &&
      deps.postedSince(turn.sessionId, from, turn.postsUntil ?? Number.POSITIVE_INFINITY)
    )
  }
  return {
    posted,
    sending: (row) => sending.has(keyOf(row)),
    hold: async (turn, own) => {
      const store = deps.journal()
      if (
        !store ||
        !turn.live ||
        !turn.bot ||
        !turn.askedBy ||
        turn.toolsRan === true ||
        own.length === 0 ||
        // An older build's row keeps its own quiet rule, which only the live fill applies.
        own.some((row) => row.quietRule === undefined) ||
        connectorReplyTurnOutcome(turn).outcome !== 'no_answer' ||
        turn.turnStartedAt === undefined
      ) {
        return false
      }
      if (posted(turn) || own.some((row) => row.emptyRetried)) {
        return false
      }
      const keys = own.map(keyOf)
      keys.forEach((key) => sending.add(key))
      const release = () => keys.forEach((key) => sending.delete(key))
      const cut = { turnId: turn.turnItemId, kind: 'restart' as const }
      const held = await store
        .holdForRetry({
          keys: own
            .filter((row) => row.claimMessageId === undefined)
            .map(({ account, deliveryId }) => ({ account, deliveryId })),
          claims: [...new Set(own.flatMap((row) => row.claimMessageId ?? []))],
          cut
        })
        .catch(() => false)
      if (!held) {
        release()
        return false
      }
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: RETRY_PROMPT }],
        // Orca's own ask in the conversation the turn answered, naming no one.
        ...turn.askedBy,
        connectorClaim: {
          cutTurnId: cut.turnId,
          cutKind: cut.kind,
          // The stored claim keeps only a delivery's own fields.
          origin: turn.stamps.map(({ account, conversation, deliveryId, carried }) => ({
            account,
            conversation,
            deliveryId,
            ...(carried ? { carried } : {})
          }))
        }
      }
      // Not awaited: the turn end goes on, and the retry's own turn fills the rows it claims.
      void deps
        .send(turn.sessionId, body, turn.turnItemId)
        .catch(() => 'unknown' as const)
        .finally(() => {
          release()
          deps.settled(turn.sessionId)
        })
      return true
    }
  }
}

/** The ask, sent only into an idle chat whose newest turn is still the empty one: a running turn
 *  would take it in as a steer, and a newer one would be the turn it asks about. A continuation, so
 *  no Slack mirror posts it as the owner's. */
export function emptyRetrySend(
  chat: () => (ConversationChat & Pick<StructuredAgentSessionHost, 'queuedMessageDelete'>) | null,
  /** Connectors turned off: nothing is sent, and the next recovery closes what was held. */
  signal: AbortSignal
): EmptyRetrySend {
  return async (sessionId, body, turnItemId) => {
    const host = chat()
    const record = host?.deps.store.getConversation(sessionId)
    const ready = () =>
      !signal.aborted &&
      chatIsIdle(host, sessionId) &&
      host?.publishedWork(sessionId)?.latestTurn?.itemId === turnItemId
    if (!host || !record || !ready()) {
      return 'refused'
    }
    let admitted = false
    try {
      const sent = await host.send(callerFor({ sessionId }), {
        ...structuredAgentSessionMessageSendMutation({
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          expectedRuntimeFence: record.currentFence,
          body
        }),
        continuation: true,
        // Under the chat's admission, from its journal rather than its last published status: a
        // message that reached it meanwhile, or a newer turn, refuses the ask.
        beforeRun: async () => {
          const work = await host.currentWork(sessionId)
          if (
            signal.aborted ||
            !work ||
            work.working() ||
            work.owesAnySend() ||
            work.hasActionablePrompt() ||
            work.publishedLatestTurn(null)?.itemId !== turnItemId
          ) {
            throw new Error('chat_moved_on')
          }
          admitted = true
        }
      })
      if (!sent.ok) {
        return 'refused'
      }
      // Queued behind a waiting card, it would run in a later turn: take it back, which hands its
      // claim back to the cut, so recovery closes the request with no answer.
      if ('queued' in sent.value) {
        const fields = { messageId: sent.value.clientMessageId }
        const withdrawal = envelope(host, { sessionId }, 'agentSession.queuedMessageDelete', fields)
        const withdrawn =
          withdrawal &&
          (await host
            .queuedMessageDelete(callerFor({ sessionId }), { envelope: withdrawal, ...fields })
            .catch(() => null))
        return withdrawn?.ok ? 'refused' : 'unknown'
      }
      return 'accepted'
    } catch {
      return admitted ? 'unknown' : 'refused'
    }
  }
}

/** Rows an empty turn held for its retry share one answer per conversation, as its live fill would
 *  have keyed them: the earliest admitted, by one pass over the read's messages. */
export function heldHeads(
  rows: readonly JournalConnectorReplyRow[],
  items: readonly AgentJournalRenderItem[]
): Map<JournalConnectorReplyRow, string> {
  const held = rows.filter((row) => row.emptyRetried && row.cut)
  if (held.length === 0) {
    return new Map()
  }
  const admittedAt = new Map<string, number>()
  for (const item of items) {
    const delivery = item.body.kind === 'message' ? item.body.connectorDelivery : undefined
    const ids = delivery ? [delivery.deliveryId, ...(delivery.carried ?? [])] : []
    ids.forEach((deliveryId, index) => {
      const key = keyOf({ account: delivery!.account, deliveryId })
      // A message's own delivery heads the ones it carries, as the live fill keys them.
      if (!admittedAt.has(key)) {
        admittedAt.set(key, item.sequence + index / (ids.length + 1))
      }
    })
  }
  const groupOf = (row: JournalConnectorReplyRow) =>
    JSON.stringify([row.cut?.turnId, row.account, row.conversation])
  const first = new Map<string, { row: JournalConnectorReplyRow; at: number }>()
  for (const row of held) {
    const at = admittedAt.get(keyOf(row)) ?? Number.MAX_SAFE_INTEGER
    const known = first.get(groupOf(row))
    if (!known || at < known.at) {
      first.set(groupOf(row), { row, at })
    }
  }
  return new Map(held.map((row) => [row, first.get(groupOf(row))!.row.deliveryId]))
}

/** The app's retry: posts counted per chat, and a settled ask handed to recovery once it exists. */
export function liveEmptyTurnRetry(
  journal: () => ConnectorReplyCutJournal | null,
  chat: Parameters<typeof emptyRetrySend>[0],
  signal: AbortSignal
): { retry: EmptyTurnRetry; settleWith: (recovery: { turnEnded: (id: string) => void }) => void } {
  let settle: (sessionId: string) => void = () => {}
  const retry = emptyTurnRetry({
    journal,
    postedSince: (sessionId, at, until) =>
      connectorPostAttempts.since(chatPaneKey(sessionId), at, until),
    send: emptyRetrySend(chat, signal),
    settled: (sessionId) => {
      if (!signal.aborted) {
        settle(sessionId)
      }
    }
  })
  return { retry, settleWith: (recovery) => (settle = (id) => recovery.turnEnded(id)) }
}
