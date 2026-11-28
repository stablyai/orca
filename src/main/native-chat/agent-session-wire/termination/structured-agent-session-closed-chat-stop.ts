import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionCloseCause,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'

/** Stops a closed chat's provider. One a person's close ended while it ran did not exit on its own,
 *  so the host hears of it. Call under the session's serialization. */
export async function stopClosedChat(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  cause: StructuredAgentSessionCloseCause
): Promise<void> {
  const session = context.sessions.get(sessionId)
  const running = session?.child
  await stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, { cause })
  const ended = session?.lastEndedChild
  // The close's own cause decides: one that only joined another stop (a workspace sleep's) is not a person's.
  if (cause === 'user-close' && running && ended?.rootGone && sameProviderChild(ended, running)) {
    context.deps.onUserClosedProvider?.({ sessionId, fence: ended.fence })
  }
}
