import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

export function publishStructuredGenerationEnded(
  input: {
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
    publications?: Pick<StructuredAgentSessionConversations, 'publish'>
    client: Pick<
      StructuredAgentSessionClientDelivery,
      'requestFailures' | 'subscribers' | 'publishJournal'
    >
    deps: Pick<StructuredAgentSessionHostDeps, 'logger' | 'store'>
  },
  sessionId: string,
  options: { restate?: boolean }
): void {
  const session = input.sessions.get(sessionId)
  if (!session) {
    return
  }
  session.operationalRevision = (session.operationalRevision ?? 0) + 1
  const { journal } = session
  input.publications?.publish(sessionId, 'operational')
  void journal
    .readInOrder(() => {
      if (input.sessions.get(sessionId) !== session || session.journal !== journal) {
        return
      }
      try {
        input.client.requestFailures.generationEnded(sessionId)
      } catch (error) {
        input.deps.logger.warn('observing a request death failed', {
          scope: 'request-outcomes',
          sessionId,
          error
        })
      }
      if (options.restate) {
        const fence = structuredAgentSessionConversationFence(input.deps.store, sessionId)
        input.client.subscribers.snapshot(sessionId, journal, fence)
        return
      }
      input.client.subscribers.deliverFrames(sessionId, journal)
      input.client.publishJournal(sessionId, journal, false)
    })
    .catch((error) =>
      input.deps.logger.warn('publishing generation-end evidence failed', {
        scope: 'journal-delivery',
        sessionId,
        error
      })
    )
}
