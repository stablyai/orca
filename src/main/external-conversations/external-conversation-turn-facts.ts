// Whether a chat's running turn is its conversation's, read from the chat's journal and its link.
import { currentChat, type ConversationChatHost } from './external-conversation-chat'
import {
  findLinkForSession,
  sameConversation,
  type ExternalConversationLinkStore
} from './external-conversation-links'
import { isConversationReport } from './external-conversation-turn-opener'
import { promptOfWake, wokenRunningTurn } from './external-conversation-wake-answers'
import { pendingPromptItem } from './external-conversation-chat-prompts'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'

/** Whether mail finishing its conversation's ask (isConversationReport) opened the chat's running turn;
 *  read from its journal, so it holds across watches and restarts. */
export function runningTurnOpenedByConversationReport(
  chats: ConversationChatHost | undefined,
  sessionId: string
): boolean {
  const opener = currentChat(chats)?.publishedWork(sessionId)?.activeTurnOpener
  return opener ? isConversationReport(opener.body) : false
}

/** Whether a chat's running turn is its conversation's (conversationOwnsTurn): a delivery it took
 *  (`pending`), a continuation claiming the link's requests, mail finishing its ask, or a wake-up for
 *  runs its turns started. */
export function chatTurnFacts(
  chats: ConversationChatHost | undefined,
  store: ExternalConversationLinkStore,
  pending: (sessionId: string) => boolean
) {
  // A continuation answering this link's requests a restart or usage limit cut: durable, unlike a
  // delivery's mark. One claiming another conversation's (the chat moved since) is not this one's.
  const claimed = (sessionId: string): boolean => {
    const opener = currentChat(chats)?.publishedWork(sessionId)?.activeTurnOpener
    const claim = opener?.body.kind === 'message' ? opener.body.connectorClaim : undefined
    const link = claim && findLinkForSession(store, sessionId)?.link
    return !!link && claim.origin.some((stamp) => sameConversation(link, stamp.conversation))
  }
  return {
    delivered: (sessionId: string) => pending(sessionId) || claimed(sessionId),
    reported: (sessionId: string) => runningTurnOpenedByConversationReport(chats, sessionId),
    woken: (sessionId: string) => {
      const link = findLinkForSession(store, sessionId)?.link
      const turn = currentChat(chats)?.publishedWork(sessionId)?.activeTurn
      return !!link && wokenRunningTurn(link, turn)
    }
  }
}

/** ChatTurns' reads of the same facts, and whose a running wake-up's prompt is. */
export function chatTurnWatchFacts(
  facts: ReturnType<typeof chatTurnFacts>,
  chats: ConversationChatHost | undefined
) {
  return {
    chatTurnDelivered: facts.delivered,
    runningTurnReported: facts.reported,
    runningTurnWoken: facts.woken,
    runningPromptWoken: (link: ExternalConversationLink) => {
      const chat = currentChat(chats)
      return (
        facts.woken(link.sessionId) &&
        promptOfWake(
          link,
          pendingPromptItem(chat, link)?.agentId,
          chat?.reads.childWork(link.sessionId) ?? []
        )
      )
    }
  }
}
