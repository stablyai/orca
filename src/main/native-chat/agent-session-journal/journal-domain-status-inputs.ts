import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'

const PAGE = 128
type StatusInput = { input: AgentJournalSubmission; ordinal: number }

export function journalDomainSubmission(scope: JournalSqlScope, id: string) {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(...scope.prefix, id)
  return row ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json) : undefined
}

export function journalDomainInputForItem(scope: JournalSqlScope, itemId: string) {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND item_id=? AND current=1`)
    .get(...scope.prefix, itemId)
  return row ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json) : undefined
}

export function journalDomainInputOrdinal(scope: JournalSqlScope, id: string): number {
  const row = scope.db
    .prepare(`SELECT ordinal FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(...scope.prefix, id)
  return row ? Number(scope.examined(row).ordinal) : Infinity
}

/** The original ordinal allocator counts admissions, including retained prior attempts. */
export function journalDomainInputCount(scope: JournalSqlScope): number {
  const row = scope.db
    .prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 AS count
    FROM journal_submission_attempts WHERE session_id=? AND epoch=?`)
    .get(...scope.prefix)!
  return Number(scope.examined(row).count)
}

export function journalDomainLatestSteer(scope: JournalSqlScope, turnItemId: string) {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id=?
    ORDER BY accepted_sequence DESC,ordinal DESC LIMIT 1`)
    .get(...scope.prefix, turnItemId)
  return row ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json) : undefined
}

export function journalDomainLatestSteerId(scope: JournalSqlScope, turnItemId: string) {
  const row = scope.db
    .prepare(`SELECT message_id FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id=?
    ORDER BY accepted_sequence DESC,ordinal DESC LIMIT 1`)
    .get(...scope.prefix, turnItemId)
  return row ? String(scope.examined(row).message_id) : undefined
}

/** Recovery is a requested population, never a walk through settled submission payloads. */
export function* journalDomainRecoverableSubmissions(scope: JournalSqlScope) {
  for (const { input } of recoverableInputs(scope)) {
    yield input
  }
}

function* recoverableInputs(scope: JournalSqlScope): Generator<StatusInput> {
  let ordinal = -1
  let id = ''
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,ordinal FROM journal_submission_attempts
      INDEXED BY journal_submission_recovery WHERE session_id=? AND epoch=? AND current=1
      AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))
      AND (ordinal,message_id)>(?,?) ORDER BY ordinal,message_id LIMIT ?`)
      .all(...scope.prefix, ordinal, id, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const submission = journalDomainSubmission(scope, String(row.message_id))
      if (submission) {
        yield { input: submission, ordinal: Number(row.ordinal) }
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return
    }
    ordinal = Number(last.ordinal)
    id = String(last.message_id)
  }
}

/** Only pending status obligations and the two winning settled seeds feed the pure policy. */
export function journalDomainStatusInputs(scope: JournalSqlScope) {
  const entries = new Map<string, StatusInput>()
  for (const candidate of recoverableInputs(scope)) {
    const { input } = candidate
    if (
      input.dispatchState === 'pending' ||
      input.reason !== 'host_restarted_before_acknowledgement'
    ) {
      entries.set(input.clientMessageId, candidate)
    }
  }
  const add = (row: ReturnType<ReturnType<typeof scope.db.prepare>['get']>) => {
    if (!row) {
      return
    }
    const input = scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
    entries.set(input.clientMessageId, { input, ordinal: Number(row.ordinal) })
  }
  add(
    scope.db
      .prepare(`SELECT payload_json,ordinal FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='accepted'
    ORDER BY submitted_at DESC,ordinal DESC,message_id DESC LIMIT 1`)
      .get(...scope.prefix)
  )
  add(
    scope.db
      .prepare(`SELECT payload_json,ordinal FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND request_failure=1
    ORDER BY accepted_sequence DESC,ordinal DESC,message_id DESC LIMIT 1`)
      .get(...scope.prefix)
  )
  return [...entries.values()].sort(
    (a, b) => a.input.submittedAt - b.input.submittedAt || a.ordinal - b.ordinal
  )
}

/** Non-refused positions break a same-position tie by message identity, as the input owner does. */
export function journalDomainStatusInputAfter(scope: JournalSqlScope, sequence: number) {
  let after: [number, number] | undefined
  let winner: { id: string; sequence: number; ordinal: number } | undefined
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,accepted_sequence,ordinal FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state<>'rejected'
      AND accepted_sequence IS NOT NULL AND accepted_sequence>?
      ${after ? 'AND (accepted_sequence,ordinal)>(?,?)' : ''}
      ORDER BY accepted_sequence,ordinal LIMIT ?`)
      .all(...scope.prefix, sequence, ...(after ?? []), PAGE)
    for (const row of rows) {
      scope.examined(row)
      const position = Number(row.accepted_sequence)
      if (winner && position !== winner.sequence) {
        break
      }
      const id = String(row.message_id)
      if (!winner || id.localeCompare(winner.id) < 0) {
        winner = { id, sequence: position, ordinal: Number(row.ordinal) }
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last || Number(last.accepted_sequence) !== winner?.sequence) {
      break
    }
    after = [Number(last.accepted_sequence), Number(last.ordinal)]
  }
  const input = winner && journalDomainSubmission(scope, winner.id)
  return input ? { input, ordinal: winner!.ordinal } : undefined
}
