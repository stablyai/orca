import type { StructuredAgentSessionConversationNaming } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

/** A rename made with Claude's own command names the chat as an Orca rename would. Takes the
 *  unwrapped naming: Claude already holds the name, so nothing is pushed back to echo again. */
export function nameChatFromClaudeRename(deps: {
  naming: StructuredAgentSessionConversationNaming | undefined
  logger: StructuredAgentSessionLogger
}): (sessionId: string, name: string) => void {
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  return (sessionId, name) => {
    deps.naming?.setUserName(sessionId, name, 'rename').catch((error: unknown) => {
      logger.warn('saving the name from a Claude rename failed', {
        scope: 'conversation-name',
        sessionId,
        error
      })
    })
  }
}
