// Whether a chat's running turn is its conversation's, read from the chat's journal and its link.
import { currentChat, type ConversationChatHost } from './external-conversation-chat'
import {
  findLinkForSession,
  sameConversation,
  type ExternalConversationLinkStore
} from './external-conversation-links'
import { isConversationReport } from './external-conversation-turn-opener'
import { wokenForConversation } from './external-conversation-wake-answers'

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
 *  (`pending`), a continuation claiming the link's requests, mail finishing its ask, or a wake-up of
 *  work its turn left. */
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
      return !!link && wokenForConversation(link, turn)
    }
  }
}
