import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

export type StructuredAgentSessionConversationLifetimeHost = {
  /** Resolve lazily because host collaborators are assigned after construction. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Caller already holds session serialization. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  deliveryActive: (sessionId: string) => boolean
  /** Retain status rows while a tab still lists the chat. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  childWorkOpen: (sessionId: string) => boolean
}

export function createStructuredAgentSessionStopStartingChild(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  return (sessionId: string, expired: StructuredAgentSessionProviderChildIdentity | null): void => {
    void host
      .serialize(sessionId, async () => {
        const child = host.sessions.get(sessionId)?.child
        if (
          !expired ||
          !child ||
          child.phase !== 'starting' ||
          !sameProviderChild(child, expired)
        ) {
          return
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
          cause: 'host-stop'
        })
      })
      .catch((error: unknown) =>
        host.context().deps.logger.warn('stopping an agent that could not finish starting failed', {
          scope: 'startup-limit',
          sessionId,
          error
        })
      )
  }
}
