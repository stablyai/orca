import type { AiVaultSession } from '../../shared/ai-vault-types'
import { CONVERSATION_NAME_PROMPT_OPENING } from '../../shared/conversation-name-generation'

// A naming request is one prompt and its one-line reply; a longer transcript is someone's chat.
const MAX_NAME_REQUEST_MESSAGES = 6

/**
 * Whether a transcript is Orca's own chat-naming request rather than a conversation. The agent CLI
 * saves that one-shot run beside the user's chats in the same project folder, so Session History
 * listed it, and opening it resumed the naming request instead of the chat (#29973). A transcript
 * someone kept typing into is theirs, so it needs the naming prompt as its only user turn.
 */
export function isConversationNameRequestSession(session: AiVaultSession): boolean {
  if (session.previewMessagesTruncated || session.messageCount > MAX_NAME_REQUEST_MESSAGES) {
    return false
  }
  const [request, ...followUps] = session.previewMessages.filter(
    (message) => message.role === 'user'
  )
  return (
    followUps.length === 0 &&
    request?.text.trimStart().startsWith(CONVERSATION_NAME_PROMPT_OPENING) === true
  )
}
