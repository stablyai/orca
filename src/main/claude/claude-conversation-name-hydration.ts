import type { ClaudeSession } from './claude-structured-session-state'
import {
  reportPersistedClaudeConversationName,
  type ClaudeConversationNameReporterSource
} from './claude-transcript-conversation-name'

export function hydrateClaudeConversationName(
  sessionId: string,
  sessions: ReadonlyMap<string, ClaudeSession>,
  deps: ClaudeConversationNameReporterSource
): void {
  const session = sessions.get(sessionId)
  if (session) {
    const sequence = (session.conversationNameReadSequence ?? 0) + 1
    session.conversationNameReadSequence = sequence
    session.conversationNameRead = reportPersistedClaudeConversationName(
      sessionId,
      session,
      deps,
      () => sessions.get(sessionId) === session && session.conversationNameReadSequence === sequence
    )
  }
}
