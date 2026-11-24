import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ConnectorMessageTiming } from '../../shared/connector-asker-prompt'
import {
  conversationPlaceText,
  type ConnectorSource,
  type ExternalConversationBot,
  type ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import type {
  ConnectorAsker,
  ConnectorFailure
} from '../../shared/connectors/connector-cloud-contract'

export type ConversationKey = { source: ConnectorSource; externalId: string }

export type ConversationPane = {
  conversation: ConversationKey
  worktreeId: string
  paneKey: string
}

export function conversationPane(
  link: ExternalConversationLink,
  worktreeId: string
): ConversationPane {
  return {
    conversation: { source: link.source, externalId: link.externalId },
    worktreeId,
    paneKey: link.paneKey
  }
}

/** Where a chat's agent replies: its conversation and turn, the workspace it runs in, and the bot it speaks for. */
export type ReplyTarget = {
  key: ConversationKey
  /** The linked chat's session, whose running turn says whether a reply goes there now. */
  sessionId: string
  turnId: number | null
  worktreeId: string
  bot?: ExternalConversationBot
  /** Where its replies land, as a bot reads it. */
  place: string
  /** The delivery whose answer the running turn owes this conversation: its opener's stamp. */
  answerDeliveryId?: string
}

export function replyTargetOf(
  { link, workspace }: { link: ExternalConversationLink; workspace: { worktreeId: string } },
  turnId: number | null,
  // The running turn's opening message: only its own request names the answer a reply gives.
  opener?: AgentJournalRenderItem | null
): ReplyTarget {
  const body = opener?.body.kind === 'message' ? opener.body : undefined
  // A continuation answers under the claim's first request for this conversation.
  const stamp = [
    ...(body?.connectorDelivery ? [body.connectorDelivery] : []),
    ...(body?.connectorClaim?.origin ?? [])
  ].find(
    (entry) =>
      entry.conversation.source === link.source && entry.conversation.externalId === link.externalId
  )
  return {
    ...(stamp ? { answerDeliveryId: stamp.deliveryId } : {}),
    key: { source: link.source, externalId: link.externalId },
    sessionId: link.sessionId,
    turnId,
    worktreeId: workspace.worktreeId,
    ...(link.bot ? { bot: link.bot } : {}),
    place: conversationPlaceText(link)
  }
}

export const CONNECTOR_REFUSALS = [
  'connectors_disabled',
  'agent_not_reachable',
  'unsupported_agent',
  'delivery_id_reused',
  'delivery_backlog_full',
  // An answer's: the prompt was answered or moved on, only Orca can answer it, or no such option.
  'prompt_not_pending',
  'prompt_unsupported',
  'option_not_offered',
  // Queued or held work a cancel settled before it was written.
  'conversation_cancelled',
  // A Stop pressed for a turn that is no longer the conversation's current one.
  'turn_not_running',
  // A start for a bot this Orca does not have, or one its owner paused.
  'bot_not_found',
  'bot_paused',
  // A send whose linked chat was deleted (CHAT_GONE_REFUSAL), to a cloud that then starts anew.
  'chat_gone',
  // A resume whose chat's newest turn no longer failed (NOT_FAILED_REFUSAL).
  'not_failed'
] as const
export type ConnectorRefusal = (typeof CONNECTOR_REFUSALS)[number]

/** accepted confirms the chat took the message, not that the agent acted on it. */
export type Delivery =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: ConnectorRefusal; failure?: ConnectorFailure }
  | {
      outcome: 'unknown'
      reason: 'writer_failed' | 'replayed_after_restart'
    }

/** A delivered message: the text as an older Orca reads it, and on a bot's, who asked, where, what
 *  they wrote and what came before, which the agent reads instead. `note` follows either: the bot's
 *  automations the message also matches. `memorySource` labels an event no one asked through. */
export type ConnectorMessage = {
  text: string
  asker?: ConnectorAsker
  note?: string
  memorySource?: string
  /** When it was sent and how long it waited for this machine, from a cloud that says. */
  sent?: ConnectorMessageTiming
  /** The same person's later messages that waited with it, read in the same turn. */
  later?: ConnectorLaterText[]
  /** Admitted through the account's reply outbox, with the later deliveries it carries. */
  reply?: { account: string; carried?: string[] }
  /** Resume on a failed turn's status: delivered only while the chat it reaches still awaits it. */
  resume?: true
}

/** A later message as the turn takes it: its words as an older Orca reads them, and its asker. */
export type ConnectorLaterText = {
  text: string
  asker?: ConnectorAsker
  sent?: ConnectorMessageTiming
}

/** What a connector start carries: the bot's home and its agent, checked by the seam, and who asked. */
export type ConnectorStartInput = Pick<
  ConnectorMessage,
  'asker' | 'note' | 'sent' | 'later' | 'reply'
> & {
  agent: string
  target: ExternalConversationBot
  prompt: string
}

export type ConversationStart = { conversation: ConversationKey; initial: Delivery }

export function refused(reason: ConnectorRefusal, failure?: ConnectorFailure): Delivery {
  return { outcome: 'refused', reason, ...(failure ? { failure } : {}) }
}

// Encode the pair structurally to avoid collisions when IDs contain delimiters.
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
