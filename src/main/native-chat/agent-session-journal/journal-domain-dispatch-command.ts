import type Database from '../../sqlite/sync-database'
import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  agentSessionStoppedHistoryOwed,
  selectStoppedHistory
} from '../../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import type { JournalDomainDispatchOperation } from './journal-domain-dispatch'
import type { JournalWriterOperation } from './journal-writer-command'
import type { JournalDomainSubmissionTarget } from './journal-domain-submission-records'
import { readJournalDomainSubmissionBody } from './journal-domain-submission-records'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { journalDomainStoppedHistoryInputs } from './journal-domain-stopped-inputs'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'

/** Claim stopped text with its carrier's pending handover, before any provider write. */
export function applyJournalDomainDispatchCommand(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: JournalDomainDispatchOperation | Extract<JournalWriterOperation, { kind: 'handover' }>,
  savedAt: number
) {
  if (operation.kind !== 'handover') {
    return applyJournalDomainDispatch(db, target, operation, savedAt)
  }
  const { input } = operation
  const scope = new JournalSqlScope(db, target.sessionId, target.epoch)
  const submission = journalDomainSubmission(scope, input.clientMessageId)
  const canCarry =
    input.turnScope.kind === 'thread' &&
    submission &&
    agentSessionSendDeliversStoppedHistory(submission, input.body) &&
    agentSessionSendCarriesStoppedHistory(input.body)
  const floor = canCarry ? new JournalSqlStatusContext(scope).contextFloor() : 0
  const carried = canCarry
    ? selectStoppedHistory(
        agentSessionStoppedHistoryOwed({
          submissions: journalDomainStoppedHistoryInputs(scope, input.clientMessageId, floor),
          carried: new Map(),
          clearSequence: floor,
          body: (id) => readJournalDomainSubmissionBody(db, target, id)
        }),
        input.body
      )
    : null
  const result = applyJournalDomainDispatch(
    db,
    target,
    {
      kind: 'dispatch',
      input: {
        clientMessageId: input.clientMessageId,
        state: 'pending',
        fence: input.fence,
        turnScope: input.turnScope,
        carries: carried?.covers ?? []
      }
    },
    savedAt
  )
  return { ...result, value: carried }
}
