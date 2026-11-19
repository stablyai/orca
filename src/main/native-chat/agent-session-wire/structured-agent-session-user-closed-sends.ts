// After the user closed a chat, its sends accepted by then become cards instead of reaching a new agent.

import { holdClosedStructuredAgentSessionSends } from './termination/structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './host/structured-agent-session-host-types'

/** True when nothing is owed; false means settlement failed. */
export async function closeWhatTheUserClosed(
  deps: Pick<StructuredAgentSessionHostDeps, 'logger' | 'store'>,
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  sessionId: string
): Promise<boolean> {
  const session = sessions.get(sessionId)
  const ended = session?.lastEndedChild
  return !session || session.child || ended?.cause !== 'user-close'
    ? true
    : holdClosedStructuredAgentSessionSends(deps, sessionId, session.journal, {
        mark: 'settled',
        select: { acceptedThrough: ended.endedAt }
      })
}
