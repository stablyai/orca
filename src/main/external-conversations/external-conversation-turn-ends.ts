// The ends of chat turns their conversation didn't ask for: one adopted for its prompt tells how it
// went and never what it said; an Orca-typed turn of a chat posting to Slack posts its reply too.
import type { NativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import type { ChatNews } from './external-conversation-chat'
import type { ConversationEvent } from './external-conversation-events'
import { connectorFailure } from './external-conversation-failure'
import type { SlackMirrorTurn } from './slack-mirror'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
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
  })
}

// A turn's length by the machine's clock, when its start was seen and the clock ran forward.
function tookOf(ended: ChatTurnEnd['ended']): { tookMs?: number } {
  return ended.turnId !== null && ended.at > ended.turnId ? { tookMs: ended.at - ended.turnId } : {}
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

/**
 * A turn that answered requests admitted through the reply outbox: their rows are filled, and a
 * conversation they cover hears the turn's state only (design item 125 §3). False when the legacy
 * turn end still tells this conversation; true, too, once the end reaches no one.
 */
export async function endRepliedTurn(
  end: ChatTurnEnd,
  turn: EndedChatTurn,
  link: ExternalConversationLink,
  links: () => Promise<ConnectorWorkLink[]>,
  fill: ConversationReplyFill | null | undefined
): Promise<boolean> {
  // A reset meanwhile: the end reaches no one, either way.
  if (!end.current()) {
    return true
  }
  if (!fill || !turn.stamps?.length || !turn.turnItemId) {
    return false
  }
  const failure =
    end.news.outcome === 'failure' ? { failure: connectorFailure(turn.failure, end.agent) } : {}
  const covered = await fill({
    sessionId: end.news.sessionId,
    turnItemId: turn.turnItemId,
    stamps: turn.stamps,
    outcome: end.news.outcome,
    prose: turn.turnProse ?? '',
    bot: Boolean(link.bot),
    links: link.bot ? await links() : [],
    ...tookOf(end.ended),
    ...failure
  }).catch((error: unknown) => {
    console.warn('[connector] could not fill reply outbox rows', error)
    return new Set<string>()
  })
  if (!end.current() || !covered.has(link.externalId)) {
    return !end.current()
  }
  await end.workersChecked()
  if (end.current()) {
    // The cloud keeps the thread's failure from whichever of this and the reply lands last.
    end.emit({ ...end.ended, ...end.turnFor(turn), stateOnly: true, ...failure })
  }
  return true
}
