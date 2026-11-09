import { claudeHoldsDispatch } from '../claude-command-lifecycle'
import type { StructuredAgentSessionSetOptionInput } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'

/** Model is local setModel metadata. Effort and Fast mode need a CLI capability check. */
export function claudeCanSetOptionWhileIdle(
  sessions: ReadonlyMap<string, ClaudeSession>,
  input: StructuredAgentSessionSetOptionInput
): boolean {
  const session = sessions.get(input.sessionId)
  return (
    !!session &&
    session.fence === input.fence &&
    input.key === 'model' &&
    session.connection.exitVerdict.root === 'live' &&
    !session.closeEnded &&
    !claudeHoldsDispatch(session)
  )
}
