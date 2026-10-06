import { claudePromptCardWritten } from './claude-child-work-evidence'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

type ClaudeEventDelivery = {
  session: ClaudeSession | null
  event: ClaudeStructuredSessionEvent
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'onEvent'>
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
  // Host evidence follows the journal; the tracker's roster remains available to contract tests.
  if (event.type === 'ended') {
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Free the child before its withdrawn card is written closed.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  deps.onEvent?.(event)
  publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
  // A prompt blocks its child only after the journal has written its card.
  void claudePromptCardWritten(session, event)?.then(() => publishChildWork(event.sessionId))
}
