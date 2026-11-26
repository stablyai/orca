import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { StructuredAgentSessionPromptStanding } from '../native-chat/agent-session-wire/observations/structured-agent-session-prompt-standing'
import { currentChat, type ConversationChatHost } from './external-conversation-chat'

function chatPromptStanding(
  chats: ConversationChatHost | undefined,
  link: Pick<ExternalConversationLink, 'sessionId'>,
  promptId: string,
  known?: AgentJournalCursor
): StructuredAgentSessionPromptStanding {
  const read = currentChat(chats)?.publishedWork(link.sessionId)?.promptStandings
  if (!read) {
    return 'unknown'
  }
  if (Object.hasOwn(read.items, promptId)) {
    return read.items[promptId]!
  }
  // The complete pending population proves resolution/rewind only for an item seen in this epoch.
  return known && known.epoch === read.cursor.epoch && known.sequence <= read.cursor.sequence
    ? 'gone'
    : 'unknown'
}

export function chatPromptReads(chats: ConversationChatHost | undefined) {
  return {
    promptStanding: (
      link: ExternalConversationLink,
      promptId: string,
      known?: AgentJournalCursor
    ) => chatPromptStanding(chats, link, promptId, known),
    promptCursor: (link: ExternalConversationLink, promptId: string) => {
      const read = currentChat(chats)?.publishedWork(link.sessionId)?.promptStandings
      return read && Object.hasOwn(read.items, promptId) ? read.cursor : undefined
    }
  }
}
