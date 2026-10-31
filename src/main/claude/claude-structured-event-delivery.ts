import { claudePromptCardWritten } from './claude-child-work-evidence'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'onEvent' | 'requestTimeoutMs' | 'logger'>
  publishChildWork: (
    sessionId: string,
    session?: ClaudeSession | null,
    message?: Record<string, unknown> | null
  ) => void
}

export function emitClaudeStructuredSessionEvent({
  session,
  event,
  deps,
  publishChildWork
}: ClaudeEventDelivery): void {
  if (event.type === 'ended') {
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Clear waiting before journaling cancellation so status cannot wait on a closed card.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  deps.onEvent?.(event)
  publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
  // Child waiting requires the card to be durable.
  void claudePromptCardWritten(session, event)?.then(() => publishChildWork(event.sessionId))
}
