import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import type { CodexJournalCommandTurn } from './codex-journal-command-turn'
import type { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

/** The native review delegates work but forwards its items onto the parent turn. */
export function handleCodexReviewNotification(
  event: CodexStructuredSessionEvent,
  primaryThreadId: string | null,
  commands: CodexJournalCommandTurn,
  boundaries: CodexJournalTurnBoundaries
): CodexJournalTranslationAdmission | null {
  if (event.type !== 'notification' || event.threadId !== primaryThreadId) {
    return null
  }
  const reviewTurn = commands.reviewTurn()
  if (reviewTurn === undefined) {
    return null
  }
  const item = readCodexJournalRecord(readCodexJournalRecord(event.params).item)
  if (event.method === 'turn/started') {
    if (commands.isReviewDelegateStart(event.params)) {
      return CODEX_JOURNAL_ADMITTED
    }
    commands.forgetPendingReview()
  }
  if (
    (event.method === 'item/started' || event.method === 'item/completed') &&
    item.type === 'userMessage' &&
    reviewTurn !== null &&
    readCodexTurnId(event.params) === reviewTurn
  ) {
    return CODEX_JOURNAL_ADMITTED
  }
  if (item.type === 'enteredReviewMode' && event.method === 'item/started') {
    const turnId = readCodexTurnId(event.params)
    if (turnId) {
      const admission = boundaries.start({ ...event, params: { turn: { id: turnId } } })
      if (!admission.accepted) {
        return admission
      }
    }
  }
  return null
}
