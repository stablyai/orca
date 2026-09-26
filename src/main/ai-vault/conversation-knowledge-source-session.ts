import type { AiVaultSession } from '../../shared/ai-vault-types'
import { isConversationKnowledgeGenerationTitle } from '../../shared/conversation-knowledge-items'

export function conversationKnowledgeId(session: AiVaultSession): string {
  return `${session.executionHostId}:${session.agent}:${session.sessionId}`
}

export function isKnowledgeGenerationSession(session: AiVaultSession): boolean {
  return isConversationKnowledgeGenerationTitle(session.title)
}

export function conversationPathIsWithin(scopePath: string, candidatePath: string): boolean {
  const scope = scopePath.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
  const candidate = candidatePath.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
  return candidate === scope || candidate.startsWith(`${scope}/`)
}
