import type Database from '../../sqlite/sync-database'
import type { AgentSessionFailureResumeResult } from '../../../shared/agent-session/agent-session-held-delivery'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { JournalSqlScope } from './journal-sql-scope'
import { journalDomainInputEligibility } from './journal-domain-input-eligibility'
import { readJournalDomainHeldDelivery } from './journal-domain-held-delivery'
import { readJournalDomainQueueFailureSource } from './journal-domain-queue-failures'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'

type Resume = Extract<JournalWriterCommand['operation'], { kind: 'failure-resume' }>
type Target = { sessionId: string; epoch: string }
type Ready = { status: 'ready'; waiting: number; itemId: string; failedAt: number }

export function prepareJournalFailureResume(
  db: Database.Database,
  target: Target,
  operation: Resume,
  authority: JournalCurrentWorkAuthority | undefined,
  reopenFloor: AgentJournalCursor | null
): Ready | AgentSessionFailureResumeResult {
  if (!db.isTransaction || !authority) {
    throw new Error('failure recovery requires writer authority')
  }
  const failure = readJournalDomainHeldDelivery(db, target, reopenFloor, true)
  const waiting = failure?.waiting ?? 0
  if (!failure) {
    return { status: 'not-failed', waiting }
  }
  if (failure.failureId !== operation.expectedFailureId) {
    return { status: 'stale-failure', waiting }
  }
  const source = readJournalDomainQueueFailureSource(db, target)!
  const used = db
    .prepare(
      `SELECT 1 FROM journal_failure_resumes WHERE session_id=? AND epoch=? AND failure_id=?`
    )
    .get(target.sessionId, target.epoch, operation.expectedFailureId)
  if (used || failure.recoveryUsed) {
    return { status: 'already-used', waiting }
  }
  const pauses = readJournalDomainQueuePauseContext(db, target, reopenFloor, [])
  if (!pauses.pauses.some((p) => p.reason === 'failed')) {
    return { status: 'not-failed', waiting }
  }
  if (operation.hasMessage) {
    return { status: 'message-attached', waiting }
  }
  const state = journalDomainInputEligibility(
    new JournalSqlScope(db, target.sessionId, target.epoch),
    authority
  )
  if (
    state.blocked ||
    state.work.working() ||
    state.prompts.length ||
    state.pending ||
    pauses.pauses.some((p) => p.reason !== 'failed')
  ) {
    return { status: 'blocked', waiting }
  }
  if (failure.reason.failure !== 'network' && failure.reason.failure !== 'provider') {
    return { status: 'not-retryable', waiting }
  }
  return { status: 'ready', waiting, itemId: source.itemId, failedAt: source.failedAt }
}

export function commitJournalFailureResume(
  db: Database.Database,
  target: Target,
  operation: Resume,
  ready: Ready,
  sequence: number
): void {
  db.prepare(`INSERT INTO journal_failure_resumes
    (session_id,epoch,failure_id,source_item_id,failed_at,operation_id,coordinator_id,dispatch_id,released_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    target.sessionId,
    target.epoch,
    operation.expectedFailureId,
    ready.itemId,
    ready.failedAt,
    operation.operationId,
    operation.coordinatorId,
    operation.dispatchId,
    sequence
  )
}
