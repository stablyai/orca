import {
  AGENT_JOURNAL_DISPATCH_STATES,
  type AgentJournalRetryLineage
} from '../../../shared/agent-session/journal/agent-session-journal-dispatch'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { SEND_RETRY_ROOT_SQL } from './database/journal-submission-window-indexes'
import type { JournalSqlScope } from './journal-sql-scope'

export function journalRetryLookupSql(liveOnly: boolean): string {
  return `SELECT message_id,dispatch_state,submitted_at FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND ${SEND_RETRY_ROOT_SQL}=?
      ${liveOnly ? "AND dispatch_state<>'rejected'" : ''}
    ORDER BY ordinal DESC LIMIT 1`
}

export function journalDomainLastRetry(
  scope: JournalSqlScope,
  root: string,
  liveOnly: boolean
): AgentJournalRetryLineage | undefined {
  const row = scope.db.prepare(journalRetryLookupSql(liveOnly)).get(...scope.prefix, root)
  const dispatchState = AGENT_JOURNAL_DISPATCH_STATES.find((state) => state === row?.dispatch_state)
  if (row && typeof row.message_id === 'string' && dispatchState) {
    scope.examined(row)
    return { clientMessageId: row.message_id, dispatchState, submittedAt: Number(row.submitted_at) }
  }
  return undefined
}

export function journalRetryHistoryPresentation(scope: JournalSqlScope) {
  const retries = new Map<string, AgentJournalRetryLineage | undefined>()
  return (submission: AgentJournalSubmission): AgentJournalSubmission => {
    const root =
      submission.retryOfClientMessageId ??
      (submission.dispatchState === 'rejected' &&
      readAgentSessionFailureFact(submission.rejection)?.instructionRecovery
        ? submission.clientMessageId
        : undefined)
    if (!root) {
      return submission
    }
    if (!retries.has(root)) {
      retries.set(
        root,
        journalDomainLastRetry(scope, root, true) ?? journalDomainLastRetry(scope, root, false)
      )
    }
    const retryLineage = retries.get(root)
    return retryLineage ? { ...submission, retryLineage } : submission
  }
}
