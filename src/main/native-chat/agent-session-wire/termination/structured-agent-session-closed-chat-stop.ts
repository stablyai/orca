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
  // This close ended a live provider only when both causes are a person's: one that joined another stop did not.
  if (cause === 'user-close' && running && ended?.cause === 'user-close') {
    context.deps.onUserClosedProvider?.({ sessionId, fence: ended.fence })
  }
}
