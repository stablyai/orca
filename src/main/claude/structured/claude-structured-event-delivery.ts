import { ClaudePluginInputError } from '../claude-plugin-ui'
import { claudePromptCardWritten } from '../claude-child-work-evidence'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSessionExit,
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

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
  if (event.type === 'retiring') {
    // Retire host input before publishing the logical failure to subscribers.
    deps.onEvent?.(event)
  }
  if (event.type === 'ended' || event.type === 'retiring') {
    session?.childWork.clear()
    session?.backgroundTasks.clear()
  } else if (event.type === 'message') {
    session?.childWork.observe(event.message, session.translator?.childToolOwner)
    session?.backgroundTasks.observe(event.message, event.startsTurn === true)
  } else if (event.type === 'prompt-cancelled') {
    // Clear waiting before journaling cancellation so status cannot wait on a closed card.
    publishChildWork(event.sessionId, session)
  }
  if (event.type === 'message' && session?.commands.observe(event.message)) {
    session.events?.publish()
  }
  session?.translator?.handle(event)
  if (event.type !== 'retiring') {
    deps.onEvent?.(event)
  }
  publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
  // Child waiting requires the card to be durable.
  void claudePromptCardWritten(session, event)?.then(() => publishChildWork(event.sessionId))
}

export function deliverClaudeConnectionEvent(
  sessions: ReadonlyMap<string, ClaudeSession>,
  exits: ReadonlyMap<string, ClaudeSessionExit>,
  attempt: ClaudeAcquisitionAttempt,
  sessionId: string,
  event: () => void
): void {
  if (!attempt.published) {
    attempt.buffered.push(event)
    return
  }
  if (exits.get(sessionId)?.error instanceof ClaudePluginInputError) {
    return
  }
  if (
    sessions.get(sessionId)?.connection === attempt.connection ||
    exits.get(sessionId)?.connection === attempt.connection
  ) {
    event()
  }
}
