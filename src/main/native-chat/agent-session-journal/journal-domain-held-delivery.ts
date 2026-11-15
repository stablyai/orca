import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHeldDelivery,
  WorkerFailureKind
} from '../../../shared/agent-session/agent-session-held-delivery'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { readJournalDomainQueueFailureSource } from './journal-domain-queue-failures'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'

export function readJournalDomainHeldDelivery(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  reopenFloor: AgentJournalCursor | null,
  includeReleased = false
): AgentSessionHeldDelivery | null {
  const source = readJournalDomainQueueFailureSource(db, target)
  const context = readJournalDomainQueuePauseContext(db, target, reopenFloor, [])
  if (!source || (!includeReleased && !context.pauses.some((p) => p.reason === 'failed'))) {
    return null
  }
  const report = db
    .prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND queue_failure_report_turn_item_id=?
    ORDER BY ordinal DESC LIMIT 1`)
    .get(target.sessionId, target.epoch, source.itemId)
  const body: AgentJournalRenderItem['body'] | undefined = report
    ? JSON.parse(String(report.payload_json)).body
    : undefined
  const fact = body?.kind === 'status' ? readAgentSessionFailureFact(body.failure) : undefined
  let failure: WorkerFailureKind = 'unknown'
  if (fact?.kind === 'notSignedIn') {
    failure = 'sign-in'
  } else if (fact?.kind === 'usageLimitReached') {
    failure = 'usage-limit'
  } else if (
    fact?.kind === 'providerUnavailable' ||
    fact?.kind === 'providerResponseFailed' ||
    fact?.kind === 'providerRejected'
  ) {
    failure = 'provider'
  }
  if (
    fact?.retry &&
    [
      'network_error',
      'connection_error',
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected'
    ].includes(fact.retry.error ?? '')
  ) {
    failure = 'network'
  }
  const waiting = db
    .prepare(`SELECT COUNT(*) AS count FROM journal_queue_cards
    WHERE session_id=? AND epoch=? AND state='waiting'`)
    .get(target.sessionId, target.epoch)
  const failureId = createHash('sha256')
    .update(JSON.stringify([target.sessionId, target.epoch, source.itemId, source.failedAt]))
    .digest('hex')
  const prior = db
    .prepare(
      `SELECT released_at FROM journal_failure_resumes WHERE session_id=? AND epoch=? ORDER BY released_at DESC LIMIT 1`
    )
    .get(target.sessionId, target.epoch)
  const recoveredAfter = prior ? Number(prior.released_at) : 0
  const personal = recoveredAfter
    ? db
        .prepare(`SELECT 1 FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND dispatch_state='accepted' AND admitted_personal=1 AND accepted_sequence>? LIMIT 1`)
        .get(target.sessionId, target.epoch, recoveredAfter)
    : undefined
  const success = recoveredAfter
    ? db
        .prepare(`SELECT 1 FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1
      AND sequence>? AND sequence<? AND json_extract(payload_json,'$.body.outcome')='success' LIMIT 1`)
        .get(target.sessionId, target.epoch, recoveredAfter, source.failedAt)
    : undefined
  return {
    delivered: false,
    state: 'held',
    reason: { kind: 'worker_failed', failure },
    failureId,
    target: { sessionId: target.sessionId },
    waiting: Number(waiting?.count ?? 0),
    ...(recoveredAfter &&
    source.failedAt > recoveredAfter &&
    !personal &&
    !success &&
    context.marks.resumedSequence <= recoveredAfter
      ? { recoveryUsed: true }
      : {}),
    ...(fact?.usageLimit?.resetsAt ? { resetsAt: fact.usageLimit.resetsAt } : {})
  }
}
