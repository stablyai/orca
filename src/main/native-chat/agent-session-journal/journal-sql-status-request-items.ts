import type { JournalSqlScope } from './journal-sql-scope'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

const PAGE = 128

/** Existence needs no payload; count all reached user metadata, including associated rows. */
export function sqlHasStatusRequestItem(scope: JournalSqlScope): boolean {
  for (const predicate of ['turn_id IS NOT NULL', "message_role='assistant'"]) {
    const found = scope.db
      .prepare(`SELECT entry_key FROM journal_proj_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND ${predicate} LIMIT 1`)
      .get(...scope.prefix)
    if (found) {
      scope.examined(found)
      return true
    }
  }
  let after = ''
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT i.entry_key,
      EXISTS(SELECT 1 FROM journal_proj_submissions s WHERE s.session_id=i.session_id
        AND s.epoch=i.epoch AND s.current=1 AND s.item_key=i.entry_key) AS submitted
      FROM journal_proj_items i WHERE i.session_id=? AND i.epoch=? AND i.hidden=0
      AND i.message_role='user' AND i.entry_key>? ORDER BY i.entry_key LIMIT ?`)
      .all(...scope.prefix, after, PAGE)
    rows.forEach((row) => scope.examined(row))
    if (rows.some((row) => row.submitted === 0)) {
      return true
    }
    const last = rows.at(-1)
    if (rows.length < PAGE || !last) {
      return false
    }
    after = String(last.entry_key)
  }
}

/** Failure evidence drives the join; only candidate metadata is sorted in render order. */
export function* sqlFailedStatusItems(
  scope: JournalSqlScope,
  item: (id: string) => AgentJournalRenderItem | undefined,
  floor: number
): Iterable<JournalStatusItem> {
  const candidates: { key: string; position: JournalStatusItem['position'] }[] = []
  let after = ''
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT p.id, s.accepted_seq, i.entry_key, i.sequence,
      i.sequence_index, i.ordinal, i.hidden, i.root
      FROM journal_proj_places p
      LEFT JOIN journal_proj_submissions s ON s.session_id=p.session_id AND s.epoch=p.epoch
        AND s.client_message_id=p.id AND s.current=1
      LEFT JOIN journal_proj_items i ON i.session_id=s.session_id AND i.epoch=s.epoch AND i.entry_key=s.item_key
      WHERE p.session_id=? AND p.epoch=? AND p.index_id='failed-requests' AND p.id>?
      ORDER BY p.id LIMIT ?`)
      .all(...scope.prefix, after, PAGE)
    for (const row of rows) {
      scope.examined(row)
      if (
        typeof row.entry_key === 'string' &&
        row.hidden === 0 &&
        row.root === 1 &&
        (!floor || (Number(row.accepted_seq ?? 0) > floor && Number(row.sequence) > floor))
      ) {
        candidates.push({
          key: row.entry_key,
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
    after = String(last.id)
  }
  candidates.sort((a, b) => compareJournalStatusPositions(b.position, a.position))
  for (const candidate of candidates) {
    const current = item(String(JSON.parse(candidate.key)))
    if (current) {
      yield { item: current, position: candidate.position }
    }
  }
}
