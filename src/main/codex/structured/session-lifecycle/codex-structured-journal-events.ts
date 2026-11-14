import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import * as turnEnd from '../turns/codex-structured-turn-end-settlement'
import { startCodexTerminalStopProbe } from '../background-work/codex-background-terminals'
import * as requestEndWait from '../turns/codex-request-end-wait'
import type {
  CodexSession,
  CodexStructuredSessionEvent,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexJournalTranslationAdmission } from '../journal/codex-structured-journal-contracts'

/** Journal first so observers never see an event ahead of its durable row. */
export function emitCodexStructuredJournalEvent(
  session: CodexSession,
  event: CodexStructuredSessionEvent,
  sessions: Map<string, CodexSession>,
  deps: CodexStructuredSessionAdapterDeps
): CodexJournalTranslationAdmission {
  if (
    event.type === 'notification' &&
    event.method === 'turn/started' &&
    session.translator?.isReviewDelegateStart(readCodexTurnId(event.params))
  ) {
    return { accepted: true }
  }
  if (event.type === 'notification') {
    turnEnd.noteCodexTurnOpened(session, event.method, event.params)
    if (event.method === 'skills/changed') {
      session.skillReport?.refresh(true)
    }
  }
  const admission = session.translator?.handle(event) ?? { accepted: true }
  if (!admission.accepted) {
    return admission
  }
  if (event.type === 'notification') {
    turnEnd.publishCodexTurnOpened(session, event, sessions)
    // Only an admitted turn end settles; a refused one settles on the retry that lands.
    turnEnd.settleCodexSendsInEndedTurn(session, event)
    // Child records observe refused frames only after a retry reaches the journal.
    session.backgroundTasks.observe(event, session.prompts.takeAbandonedCommands())
    // After the journal and the parent's republished row, never ahead of either.
    session.backgroundTasks.publishChildWork()
    startCodexTerminalStopProbe(sessions, event.sessionId, session, deps)
  }
  requestEndWait.settleCodexRequestEndWaiters(session)
  deps.onEvent?.(event)
  return admission
}
