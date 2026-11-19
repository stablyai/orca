import { normalizeAgentSessionConversationName } from '../../../../shared/agent-session/conversation-naming/agent-session-conversation-name'
import type { StructuredAgentSessionConversationNaming } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'

/** A rename made with Claude's own command names the chat as an Orca rename would. Takes the
 *  unwrapped naming: Claude already holds the name, so nothing is pushed back to echo again. */
export function nameChatFromClaudeRename(deps: {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  naming: StructuredAgentSessionConversationNaming | undefined
  logger: StructuredAgentSessionLogger
}): (sessionId: string, name: string) => void {
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  return (sessionId, name) => {
    const record = deps.store.getRecord(sessionId)
    if (
      !record ||
      (record.conversationNameSource === 'user' &&
        record.conversationName === normalizeAgentSessionConversationName(name))
    ) {
      return
    }
    deps.naming?.setUserName(sessionId, name, 'rename').catch((error: unknown) => {
      logger.warn('saving the name from a Claude rename failed', {
        scope: 'conversation-name',
        sessionId,
        error
      })
    })
  }
}
