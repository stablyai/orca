import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionRequestFailures } from './structured-agent-session-request-failures'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'

type GenerationPublication = {
  sessions: Map<string, StructuredAgentSessionHostSession>
  deps: () => StructuredAgentSessionHostDeps
  subscribers: Pick<AgentSessionSubscribers, 'restate' | 'deliverFrames'>
  requestFailures: Pick<StructuredAgentSessionRequestFailures, 'generationEnded'>
  writtenPrefix: (id: string) => Promise<StructuredAgentSessionSinkBarrier> | undefined
  publishOperational: (id: string) => void
  publishJournal: (id: string, journal: AgentSessionJournal) => void
}

export function publishStructuredAgentSessionGenerationEnded(
  context: GenerationPublication,
  sessionId: string,
  options: { restate?: boolean }
): void {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  const { journal, child } = session
  const fence = structuredAgentSessionConversationFence(context.deps().store, sessionId)
  // Capture before eviction: an absent replacement sink cannot certify the admitted tail.
  const prefix = context.writtenPrefix(sessionId)
  session.operationalRevision = (session.operationalRevision ?? 0) + 1
  context.publishOperational(sessionId)
  if (options.restate) {
    context.subscribers.restate(sessionId, journal, fence)
  } else {
    context.subscribers.deliverFrames(sessionId, journal)
  }
  if (!prefix) {
    return
  }
  void prefix
    .then((result) => {
      if (!result.ok) {
        return
      }
      return journal.readInOrder(() => {
        if (
          context.sessions.get(sessionId) !== session ||
          session.journal !== journal ||
          session.child !== child ||
          structuredAgentSessionConversationFence(context.deps().store, sessionId) !== fence
        ) {
          return
        }
        try {
          context.requestFailures.generationEnded(sessionId)
        } catch (error) {
          context.deps().logger.warn('observing a request death failed', {
            scope: 'request-outcomes',
            sessionId,
            error
          })
        }
        context.publishJournal(sessionId, journal)
      })
    })
    .catch((error: unknown) => {
      context.deps().logger.warn('observing generation journal writes failed', {
        scope: 'journal-delivery',
        sessionId,
        error
      })
    })
}
