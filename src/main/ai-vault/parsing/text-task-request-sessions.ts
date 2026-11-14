import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { DICTATION_CLEANUP_PROMPT_OPENING } from '../../../shared/dictation-cleanup'
import { CONVERSATION_NAME_PROMPT_OPENING } from '../../../shared/source-control/ai/generation/conversation-name-generation'

const MAX_TEXT_TASK_REQUEST_MESSAGES = 6

/** One-shot CLI runs (chat naming, dictation cleanup) aren't conversations; sessions with user follow-ups stay visible (#29973). */
export function isTextTaskRequestSession(session: AiVaultSession): boolean {
  if (session.previewMessagesTruncated || session.messageCount > MAX_TEXT_TASK_REQUEST_MESSAGES) {
    return false
  }
  const [request, ...followUps] = session.previewMessages.filter(
    (message) => message.role === 'user'
  )
  const text = request?.text.trimStart()
  return (
    followUps.length === 0 &&
    text !== undefined &&
    (text.startsWith(CONVERSATION_NAME_PROMPT_OPENING) ||
      text.startsWith(DICTATION_CLEANUP_PROMPT_OPENING))
  )
}
