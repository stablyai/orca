import {
  FAILURE_AUTHORITY_COLUMNS,
  journalOrchestrationAttached
} from './journal-failure-authority'
import { journalFailureCustodySql } from './journal-failure-custody'
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
type Ready = {
  status: 'ready'
  result: AgentSessionFailureResumeResult
  itemId: string
  failedAt: number
  sources: string
}

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
  if (operation.authorization && !journalOrchestrationAttached(db)) {
    return { status: 'blocked', waiting: 0 }
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
      `${journalFailureCustodySql(db)} SELECT (SELECT json_group_array(id) FROM sources) AS sources,
        EXISTS(SELECT 1 FROM journal_failure_resumes WHERE session_id=? AND epoch=? AND failure_id=?) AS used
        ${
          operation.authorization
            ? `, EXISTS(SELECT 1 FROM orchestration_authority.dispatch_contexts d
          JOIN orchestration_authority.runs r ON r.id=d.run_id WHERE d.id=? AND d.status='dispatched'
          AND r.id=? AND ${FAILURE_AUTHORITY_COLUMNS}=?) AS authorized`
            : ', 1 AS authorized'
        }`
    )
    .get(
      target.sessionId,
      target.epoch,
      target.sessionId,
      target.epoch,
      operation.expectedFailureId,
      ...(operation.authorization
        ? [operation.dispatchId, operation.authorization.runId, operation.authorization.snapshot]
        : [])
    )
  if (!used?.authorized) {
    return { status: 'blocked', waiting }
  }
  if (used?.used || failure.recoveryUsed) {
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
  return {
    status: 'ready',
    result: {
      status: 'resumed',
      waiting,
      ...(failure.individuallyHeld
        ? { stillHeld: failure.individuallyHeld, heldReason: 'held individually' }
        : {})
    },
    itemId: source.itemId,
    failedAt: source.failedAt,
    sources: String(used?.sources ?? '[]')
  }
}

export function commitJournalFailureResume(
  db: Database.Database,
  target: Target,
  operation: Resume,
  ready: Ready,
  sequence: number
): void {
  db.prepare(`INSERT INTO journal_failure_resumes
    (session_id,epoch,failure_id,source_item_id,failed_at,operation_id,coordinator_id,dispatch_id,released_at,authority_json,sources_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    target.sessionId,
    target.epoch,
    operation.expectedFailureId,
    ready.itemId,
    ready.failedAt,
    operation.operationId,
    operation.coordinatorId,
    operation.dispatchId,
    sequence,
    operation.authorization ? JSON.stringify(operation.authorization) : null,
    ready.sources
  )
}
