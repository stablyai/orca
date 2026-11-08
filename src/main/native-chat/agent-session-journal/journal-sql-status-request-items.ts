import type { JournalSqlScope } from './journal-sql-scope'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

const PAGE = 128

/** Existence seeks headers only; an associated user alone is not evidence of a provider request. */
export function sqlHasStatusRequestItem(scope: JournalSqlScope): boolean {
  for (const predicate of ['turn_id IS NOT NULL', "message_role='assistant'"]) {
    const row = scope.db
      .prepare(`SELECT 1 FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND ${predicate} LIMIT 1`)
      .get(...scope.prefix)
    if (row) {
      scope.examined(row)
      return true
    }
  }
  let after = -1
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT i.ordinal,
      EXISTS(SELECT 1 FROM journal_submission_attempts s WHERE s.session_id=i.session_id
        AND s.epoch=i.epoch AND s.current=1 AND s.item_id=i.item_id) AS submitted
      FROM journal_items i WHERE i.session_id=? AND i.epoch=? AND i.hidden=0
      AND i.kind='message' AND i.message_role='user' AND i.ordinal>? ORDER BY i.ordinal LIMIT ?`)
      .all(...scope.prefix, after, PAGE)
    rows.forEach((row) => scope.examined(row))
    if (rows.some((row) => row.submitted === 0)) {
      return true
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return false
    }
    after = Number(last.ordinal)
  }
}

/** Failure eligibility precedes the current-item join and render ordering. */
export function* sqlFailedStatusItems(
  scope: JournalSqlScope,
  item: (id: string) => AgentJournalRenderItem | undefined,
  floor: number
): Iterable<JournalStatusItem> {
  const candidates: { id: string; position: JournalStatusItem['position'] }[] = []
  for (const missingSequence of [true, false]) {
    let after: (string | number)[] | undefined
    for (;;) {
      const columns = missingSequence
        ? 's.ordinal,s.message_id'
        : 's.accepted_sequence,s.ordinal,s.message_id'
      const rows = scope.db
        .prepare(`SELECT s.message_id,s.accepted_sequence,s.ordinal AS input_ordinal,
        i.item_id,i.sequence,i.sequence_index,i.ordinal
        FROM journal_submission_attempts s LEFT JOIN journal_items i
          ON i.session_id=s.session_id AND i.epoch=s.epoch AND i.item_id=s.item_id AND i.hidden=0 AND i.root=1
        WHERE s.session_id=? AND s.epoch=? AND s.current=1 AND s.request_failure=1
        AND s.accepted_sequence IS ${missingSequence ? '' : 'NOT '}NULL
        ${after ? `AND (${columns})>(${after.map(() => '?').join(',')})` : ''}
        ORDER BY ${columns} LIMIT ?`)
        .all(...scope.prefix, ...(after ?? []), PAGE)
      for (const row of rows) {
        scope.examined(row)
        if (
          typeof row.item_id === 'string' &&
          (!floor || (Number(row.accepted_sequence ?? 0) > floor && Number(row.sequence) > floor))
        ) {
          candidates.push({
            id: row.item_id,
            position: {
              sequence: Number(row.sequence),
              sequenceIndex: Number(row.sequence_index),
              ordinal: Number(row.ordinal)
            }
          })
        }
      }
      const last = rows.at(-1)
      if (rows.length < PAGE || !last) {
        break
      }
      after = [
        ...(missingSequence ? [] : [Number(last.accepted_sequence)]),
        Number(last.input_ordinal),
        String(last.message_id)
      ]
    }
  }
  candidates.sort((a, b) => compareJournalStatusPositions(b.position, a.position))
  for (const candidate of candidates) {
    const current = item(candidate.id)
    if (current) {
      yield { item: current, position: candidate.position }
    }
  }
}
