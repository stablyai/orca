import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionCloseCause,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'

/** Stops a closed chat's provider; one a person's close ended while running is news to whoever
 *  started it. `closedBy` names who closed it. Call under the session's serialization. */
export async function stopClosedChat(
  host: { context: () => StructuredAgentSessionLifetimeContext },
  sessionId: string,
  cause: StructuredAgentSessionCloseCause,
  closedBy: string | undefined
): Promise<void> {
  const context = host.context()
  const session = context.sessions.get(sessionId)
  const running = session?.child
  await stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, {
    cause,
    ...(closedBy ? { reason: closedBy } : {})
  })
  const ended = session?.lastEndedChild
  if (
    running &&
    ended?.cause === 'user-close' &&
    ended.rootGone &&
    sameProviderChild(ended, running)
  ) {
    context.deps.onPersonClosedProvider?.({ sessionId, fence: ended.fence, closedBy: ended.reason })
  }
}
