import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import { JournalDomainRequestFailure } from './journal-domain-request-failure'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalRequestFailureRead, JournalRequestMark } from './journal-request-failure'
import { SEND_ANSWERED_TURN_SQL } from './database/journal-submission-window-indexes'

export type JournalRequestFailureResult =
  | { kind: 'request-failure'; snapshot: AgentJournalSnapshot }
  | { kind: 'running-request'; request: JournalRequestMark | null }

/** One request's words, including late scoped diagnostics, share one reader snapshot. */
export function readJournalSqlRequestFailure(
  scope: JournalSqlScope,
  operation: JournalRequestFailureRead
): JournalRequestFailureResult {
  if (operation.kind === 'running-request') {
    const running = new JournalSqlStatusContext(scope).runningTurn()
    // The adapter may have committed its interruption while the host was still receiving exit proof.
    const ended =
      !running && operation.exit
        ? scope.db
            .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_interrupted_root
          WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND kind IN ('turn','status')
          AND lifecycle_state='interrupted' AND turn_completed_at IS NOT NULL AND turn_completed_at=?
          AND turn_id IS NOT NULL AND COALESCE(execution_owner,owner_fence)=?
          ORDER BY sequence DESC,sequence_index DESC,ordinal DESC,item_id DESC LIMIT 1`)
            .get(...scope.prefix, operation.exit.observedAt, operation.exit.fence)
        : undefined
    const itemId =
      running?.item.itemId ?? (typeof ended?.item_id === 'string' ? ended.item_id : null)
    return {
      kind: operation.kind,
      request: itemId
        ? new JournalDomainRequestFailure(scope.db, scope, operation.stopSettle).request(
            'turn',
            itemId
          )
        : null
    }
  }
  const { db, prefix } = scope
  const items: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  if (operation.requestKind === 'refused-send') {
    const row = db
      .prepare(`SELECT payload_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND item_id=?`)
      .get(...prefix, operation.id)
    if (row) {
      submissions.push(scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json))
    }
  } else {
    const turn = db
      .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND root=1 AND turn_id IS NOT NULL`)
      .get(...prefix, operation.id)
    if (turn) {
      items.push(scope.decode<AgentJournalRenderItem>(scope.examined(turn).payload_json))
      const next = db
        .prepare(`SELECT sequence,sequence_index,ordinal FROM journal_items
        INDEXED BY journal_items_root_position WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
        AND turn_id IS NOT NULL AND (sequence,sequence_index,ordinal)>(?,?,?)
        ORDER BY sequence,sequence_index,ordinal LIMIT 1`)
        .get(...prefix, turn.sequence, turn.sequence_index, turn.ordinal)
      const error = `kind='status' AND CASE WHEN json_extract(payload_json,'$.body.failure') IS NOT NULL
        THEN json_extract(payload_json,'$.body.failure.kind')<>'providerRetrying'
        ELSE json_extract(payload_json,'$.body.tone')='error' END`
      const scoped = db
        .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
        INDEXED BY journal_items_stop_turn WHERE session_id=? AND epoch=? AND hidden=0
        AND turn_item_id=? AND turn_scope_kind='turn' AND root=1 AND ${error}
        ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
        .get(...prefix, operation.id)
      const legacy = db
        .prepare(`SELECT payload_json,sequence,sequence_index,ordinal FROM journal_items
        INDEXED BY journal_items_root_position WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
        AND turn_scope_kind IS NULL AND ${error} AND (sequence,sequence_index,ordinal)>(?,?,?)
        ${next ? 'AND (sequence,sequence_index,ordinal)<(?,?,?)' : ''}
        ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
        .get(
          ...prefix,
          turn.sequence,
          turn.sequence_index,
          turn.ordinal,
          ...(next ? [next.sequence, next.sequence_index, next.ordinal] : [])
        )
      const last = [scoped, legacy]
        .filter((row) => row !== undefined)
        .sort(
          (a, b) =>
            Number(b.sequence) - Number(a.sequence) ||
            Number(b.sequence_index) - Number(a.sequence_index) ||
            Number(b.ordinal) - Number(a.ordinal)
        )[0]
      if (last) {
        items.push(scope.decode<AgentJournalRenderItem>(scope.examined(last).payload_json))
      }
      const rejected = db
        .prepare(`SELECT payload_json FROM journal_submission_attempts
        INDEXED BY journal_submission_answered_turn
        WHERE session_id=? AND epoch=? AND current=1 AND request_failure=1
        AND ${SEND_ANSWERED_TURN_SQL}=?
        AND json_extract(payload_json,'$.answeredInTurn.via')='start' ORDER BY ordinal`)
        .all(...prefix, operation.id)
      submissions.push(
        ...rejected.map((row) =>
          scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
        )
      )
    }
  }
  return {
    kind: operation.kind,
    snapshot: {
      sessionId: scope.sessionId,
      cursor: journalDomainContextHead(db, scope),
      items,
      submissions
    }
  }
}
