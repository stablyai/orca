import type {
  AgentJournalSubmission,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalSqlScope } from './journal-sql-scope'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'

const PAGE = 128

/** Phase membership is current dispatch state; callers test existence, never entry order. */
export function* journalDomainEnteredInputs(scope: JournalSqlScope) {
  for (const input of journalDomainUnsettledInputs(scope)) {
    if (!isQueuedAgentJournalSubmission(input)) {
      yield input
    }
  }
}

export function* journalDomainSendingInputs(scope: JournalSqlScope) {
  yield* journalDomainUnsettledInputs(scope, true)
}

/** Ordinary outstanding inputs, including recovered unknowns which remain unsettled. */
export function* journalDomainUnsettledInputs(scope: JournalSqlScope, pendingOnly = false) {
  let after: [number, string] = [-1, '']
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,ordinal,payload_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state IN ('pending','unknown')
      ${pendingOnly ? "AND dispatch_state='pending'" : ''}
      AND (ordinal,message_id)>(?,?) ORDER BY ordinal,message_id LIMIT ?`)
      .all(...scope.prefix, ...after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const input = scope.decode<AgentJournalSubmission>(row.payload_json)
      if (input) {
        yield input
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return
    }
    after = [Number(last.ordinal), String(last.message_id)]
  }
}

export function journalDomainFirstQueuedInput(scope: JournalSqlScope) {
  for (const input of journalDomainUnsettledInputs(scope, true)) {
    if (isQueuedAgentJournalSubmission(input)) {
      return input
    }
  }
  return undefined
}

/** This population includes refused sends that received an admission sequence. */
export function* journalDomainAcceptedInputsAfter(scope: JournalSqlScope, sequence: number) {
  let after: [number, number] | undefined
  let group: { id: string; sequence: number }[] = []
  const ordered = function* () {
    group.sort((a, b) => a.id.localeCompare(b.id))
    for (const { id } of group) {
      const input = journalDomainSubmission(scope, id)
      if (input) {
        yield input
      }
    }
    group = []
  }
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,accepted_sequence,ordinal FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND current=1 AND accepted_sequence IS NOT NULL AND accepted_sequence>?
      ${after ? 'AND (accepted_sequence,ordinal)>(?,?)' : ''}
      ORDER BY accepted_sequence,ordinal LIMIT ?`)
      .all(...scope.prefix, sequence, ...(after ?? []), PAGE)
    for (const row of rows) {
      scope.examined(row)
      const position = Number(row.accepted_sequence)
      if (group.length && group[0]!.sequence !== position) {
        yield* ordered()
      }
      group.push({ id: String(row.message_id), sequence: position })
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      yield* ordered()
      return
    }
    after = [Number(last.accepted_sequence), Number(last.ordinal)]
  }
}

export function* journalDomainLinkedInputs(scope: JournalSqlScope, messageId: string) {
  let after: [number, number, number] | undefined
  const candidates: { input: AgentJournalSubmission; ordinal: number }[] = []
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT message_id,attempt_sequence,attempt_index,ordinal
      FROM journal_submission_attempts WHERE session_id=? AND epoch=? AND current=1 AND admission_family_id=?
      ${after ? 'AND (attempt_sequence,attempt_index,ordinal)>(?,?,?)' : ''}
      ORDER BY attempt_sequence,attempt_index,ordinal LIMIT ?`)
      .all(...scope.prefix, messageId, ...(after ?? []), PAGE)
    for (const row of rows) {
      scope.examined(row)
      const input = journalDomainSubmission(scope, String(row.message_id))
      if (input) {
        candidates.push({ input, ordinal: Number(row.ordinal) })
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    after = [Number(last.attempt_sequence), Number(last.attempt_index), Number(last.ordinal)]
  }
  candidates.sort((a, b) => a.ordinal - b.ordinal)
  for (const { input } of candidates) {
    yield input
  }
}

/** The input owner's raw turn sources break equal render positions by message identity. */
export function journalDomainNewestTurn(scope: JournalSqlScope) {
  const first = scope.db
    .prepare(`SELECT sequence FROM journal_items
    WHERE session_id=? AND epoch=? AND turn_marker=1
    ORDER BY sequence DESC LIMIT 1`)
    .get(...scope.prefix)
  if (!first) {
    return null
  }
  scope.examined(first)
  let newest: { id: string; index: number } | undefined
  let after = -1
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT item_id,sequence_index,ordinal FROM journal_items
      WHERE session_id=? AND epoch=? AND turn_marker=1
      AND sequence=? AND ordinal>? ORDER BY ordinal LIMIT ?`)
      .all(...scope.prefix, Number(first.sequence), after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      const id = String(row.item_id)
      const index = Number(row.sequence_index)
      if (
        !newest ||
        index > newest.index ||
        (index === newest.index && id.localeCompare(newest.id) > 0)
      ) {
        newest = { id, index }
      }
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      break
    }
    after = Number(last.ordinal)
  }
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...scope.prefix, newest!.id)!
  return readAgentJournalTurn(
    scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json).body
  )
}
