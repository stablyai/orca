import type { AiVaultSession } from '../../shared/ai-vault-types'
import { CONVERSATION_NAME_PROMPT_OPENING } from '../../shared/conversation-name-generation'

const MAX_NAME_REQUEST_MESSAGES = 6

/** CLI naming runs share chat folders; keep sessions with user follow-ups visible (#29973). */
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
