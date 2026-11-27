import { answersThroughOutbox } from '../../shared/agent-session/journal/journal-connector-reply'
// The ends of chat turns their conversation didn't ask for: one adopted for its prompt tells how it
// went and never what it said; an Orca-typed turn of a chat posting to Slack posts its reply too.
import type { NativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import type { ChatNews } from './external-conversation-chat'
import type { ConversationEvent } from './external-conversation-events'
import { connectorFailure } from './external-conversation-failure'
import type { SlackMirrorTurn } from './slack-mirror'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type {
  ConversationReplyFill,
  EndedTurnReplies,
  FilledTurn
} from './external-conversation-reply-fill'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import { connectorReplyWords } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { isSlackDirectMessage } from '../../shared/connectors/slack-direct-message'
import type { TurnLeave } from './external-conversation-thread-leaves'
export type { SlackMirrorTurn } from './slack-mirror'

export type ChatTurnEnd = {
  ended: Omit<Extract<ConversationEvent, { kind: 'turn-ended' }>, 'origin'>
  news: Extract<ChatNews, { kind: 'turn-ended' }>
  agent: NativeChatAgent
  emit: (event: ConversationEvent) => void
  /** Whom the turn acts for, once its journal is read. */
  turnFor: (turn: EndedChatTurn) => Pick<ChatTurnEnd['ended'], 'turnFor'>
  /** The turn's workers are read, so its end never reads done while they run. */
  workersChecked: () => Promise<unknown>
  /** Still the same signed-in account: false after a reset, so the end reaches no one. */
  current: () => boolean
  /** A leave of its thread made in this turn, confirmed once as the turn ends. */
  leave: TurnLeave
}

/** An adopted turn's end: how it went, never what it said or the links its work opened. A success
 *  reads only whom it acts for (by index); without that read it proves nothing. `read`: the turn
 *  already read in full. */
export function endAdoptedTurn(
  end: ChatTurnEnd,
  promptsAudience: () => boolean,
  read?: EndedChatTurn
): void {
  const failed = end.news.outcome === 'failure'
  const reading: Promise<EndedChatTurn> = read
    ? Promise.resolve(read)
    : failed
      ? end.news.readTurn()
      : (end.news.readAttribution?.() ?? Promise.resolve({}))
  void reading.then(async (turn) => {
    if (!end.current()) {
      return
    }
    await end.workersChecked()
    if (!end.current() || !promptsAudience()) {
      return
    }
    end.emit({
      ...end.ended,
      ...end.turnFor(turn),
      origin: 'local',
      ...(failed ? { failure: connectorFailure(turn.failure, end.agent) } : {})
    })
  })
}

/** Its reply posts after the owner's words: held while their post failed, until Retry or Dismiss,
 *  across a restart too. A quiet result still ends the turn, with no words. */
export function endMirroredTurn(end: ChatTurnEnd, mirrored: SlackMirrorTurn): void {
  void end.news.readTurn().then(async (read) => {
    if (!end.current()) {
      return
    }
    await end.workersChecked()
    if (!end.current()) {
      return
    }
    const message = read.lastAssistantMessage
    mirrored.release({
      ...end.ended,
      ...end.turnFor(read),
      origin: 'local',
      mirror: true,
      ...(message && !isQuietBotResult(message) ? { lastAssistantMessage: message } : {}),
      ...(end.news.outcome === 'failure'
        ? { failure: connectorFailure(read.failure, end.agent) }
        : {})
    })
    // Its line posts on its own once its end is let go and taken, kept owed until it posts.
    end.leave.settle('held')
  })
}

// The turn as its conversation knows it (its turn-started `at`), and its length by the machine's
// clock, when its start was seen and the clock ran forward.
function turnTimesOf(ended: ChatTurnEnd['ended']): { tookMs?: number; turnStartedAt?: number } {
  if (ended.turnId === null) {
    return {}
  }
  return {
    turnStartedAt: ended.turnId,
    ...(ended.at > ended.turnId ? { tookMs: ended.at - ended.turnId } : {})
  }
}

export type ChatTurnReplies = {
  /** Fills the reply outbox rows an ended turn answered (design item 125). */
  replyFill?: () => ConversationReplyFill | null
}

/** The first call reads; every later one gets that same read. */
export function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let reading: Promise<T> | null = null
  return () => (reading ??= read())
}

/** How a replied turn's end went: `told` once the outbox covers the conversation (or the end reaches
 *  no one); else the legacy turn end tells it, `not-covered` when no outbox row of it can post the
 *  answer too, `unsafe` when one may (its fill threw, or the turn's row is unknown), so recovery
 *  posts it. */
export type RepliedTurnEnd = 'told' | 'not-covered' | 'unsafe'

/**
 * A turn that answered requests admitted through the reply outbox: their rows are filled, and a
 * conversation they cover hears the turn's state only (design item 125 §3).
 */
export async function endRepliedTurn(
  end: ChatTurnEnd,
  turn: EndedChatTurn,
  link: ExternalConversationLink,
  links: () => Promise<ConnectorWorkLink[]>,
  fill: ConversationReplyFill | null | undefined
): Promise<RepliedTurnEnd> {
  // A reset meanwhile: the end reaches no one, either way.
  if (!end.current()) {
    return 'told'
  }
  if (!fill || !turn.stamps?.length) {
    return 'not-covered'
  }
  if (!turn.turnItemId) {
    return 'unsafe'
  }
  const failure = turnFailure(end, turn)
  let threw = false
  const { covered, resumesAt } = await fill({
    sessionId: end.news.sessionId,
    turnItemId: turn.turnItemId,
    stamps: turn.stamps,
    ...(turn.opener ? { openerItemId: turn.opener.itemId } : {}),
    outcome: end.news.outcome,
    prose: (link.bot ? turn.turnBotProse : turn.turnProse) ?? '',
    ...(link.bot && turn.turnProse ? { earlierProse: turn.turnProse } : {}),
    toolsRan: turn.turnToolsRan === true,
    postsUntil: end.ended.at,
    // A leave line owed at this end would post before a retry's answer: no retry then.
    ...(end.leave.owed ? {} : { live: true as const }),
    ...(turn.turnAnsweredOthers ? {} : retryAskerOf(turn.opener?.body, turn.stamps)),
    bot: Boolean(link.bot),
    links: link.bot ? await links() : [],
    ...turnTimesOf(end.ended),
    ...failure
  }).catch((error: unknown): FilledTurn => {
    console.warn('[connector] could not fill reply outbox rows', error)
    threw = true
    return { covered: new Set<string>(), paused: false }
  })
  // A turn whose stamps name this conversation answers it through the outbox only, even when its
  // rows were already sent and gone or the fill failed (recovery drains what is left): never also as
  // a full end.
  const outboxed =
    covered.has(link.externalId) || (answersThroughOutbox(link.source) && stampsName(turn, link))
  if (!end.current()) {
    return 'told'
  }
  if (!outboxed) {
    return threw ? 'unsafe' : 'not-covered'
  }
  await end.workersChecked()
  if (end.current()) {
    // The cloud keeps the thread's failure from whichever of this and the reply lands last.
    // Paused with a time the app shows: the thread says when it picks the work up (Phase 1 §4).
    end.emit({
      ...end.ended,
      ...end.turnFor(turn),
      stateOnly: true,
      ...failure,
      ...(resumesAt !== undefined && failure.failure
        ? {
            resumes: true as const,
            failure: {
              ...failure.failure,
              usageLimit: { ...failure.failure.usageLimit, resetsAt: resumesAt }
            }
          }
        : {})
    })
    end.leave.settle('end')
    return 'told'
  }
  end.leave.settle()
  return 'told'
}

/** With reply filling installed, a matching stamp covers the answer even after its row was sent.
 * An uncovered legacy turn end can use the owner DM fallback. */
export function legacyTurnWords(
  turn: EndedChatTurn,
  link: ExternalConversationLink,
  replied: Exclude<RepliedTurnEnd, 'told'>,
  reply: string | undefined
): string | null {
  const message = turn.lastAssistantMessage
  const words =
    replied === 'not-covered' && message && ownerDmAnswer(link, turn)
      ? connectorReplyWords(message, { bot: Boolean(link.bot) })
      : null
  return words ?? reply ?? null
}

/** A failed turn's reason, as its end carries it. */
export function turnFailure(
  end: ChatTurnEnd,
  turn: EndedChatTurn
): { failure?: ReturnType<typeof connectorFailure> } {
  return end.news.outcome === 'failure'
    ? { failure: connectorFailure(turn.failure, end.agent) }
    : {}
}

/** Whether the turn's journal stamps prove it answered this conversation (for its owner only). */
function stampsName(
  turn: EndedChatTurn,
  link: ExternalConversationLink,
  ownerOnly = false
): boolean {
  return Boolean(
    turn.stamps?.some(
      (stamp) =>
        stamp.conversation.source === link.source &&
        stamp.conversation.externalId === link.externalId &&
        (!ownerOnly || stamp.ownerAsked)
    )
  )
}

/** The legacy delivery records the owner on its opener even when no outbox stamp was written. */
function ownerDmAnswer(link: ExternalConversationLink, turn: EndedChatTurn): boolean {
  if (!isSlackDirectMessage(link)) {
    return false
  }
  const opener = turn.opener?.body
  return (
    stampsName(turn, link, true) ||
    (opener?.kind === 'message' &&
      opener.origin === 'connector' &&
      opener.asker?.role === 'owner' &&
      opener.connectorConversation?.source === link.source &&
      opener.connectorConversation.externalId === link.externalId)
  )
}

/** The words a turn's end carries: a bot's quiet marker carries none, however many turns it ended. */
export function turnReply(link: ExternalConversationLink, turn: EndedChatTurn): string | undefined {
  const message = turn.lastAssistantMessage
  return link.bot && message && isQuietBotResult(message) ? undefined : message
}

/** How a retry of the turn is asked, only when one request opened it (or a continuation of one cut
 *  request) and the turn answered no other. A turn that answered several requests gets no retry. */
export function retryAskerOf(
  body: AgentJournalItemBody | undefined,
  stamps: readonly { account: string; deliveryId: string; carried?: readonly string[] }[]
): Pick<EndedTurnReplies, 'askedBy'> {
  const opener = body?.kind === 'message' ? body : undefined
  const claimed = opener?.connectorClaim?.origin
  const one = opener?.connectorDelivery ?? claimed?.[0]
  if (
    !opener ||
    !one ||
    // A carried delivery is another request folded into this one: no single request then.
    one.carried?.length ||
    !stamps.every(
      (stamp) =>
        stamp.account === one.account &&
        stamp.deliveryId === one.deliveryId &&
        !stamp.carried?.length
    )
  ) {
    return {}
  }
  // Orca's own ask, like its continuations: no person's name on it, so the chat never shows it as
  // theirs, and it acts for someone Orca can't name, never the owner.
  const { connectorConversation } = opener
  return {
    askedBy: { origin: 'connector', ...(connectorConversation ? { connectorConversation } : {}) }
  }
}
