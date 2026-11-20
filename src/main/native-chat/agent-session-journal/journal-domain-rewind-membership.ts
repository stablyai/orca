import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalRewindBoundary = { sequence: number; sequenceIndex: number; ordinal: number }
/** Provider rows group by Claude turn scope, Codex turn columns, or a provider timeline's turn rows. */
export type JournalRewindScope = 'claude' | 'codex' | 'provider-timeline'
export type JournalRewindMembership = {
  floor: number
  boundary: JournalRewindBoundary
  nativeId: string
  scope: JournalRewindScope
}

export const JOURNAL_REWIND_CONTEXT = `WITH rewind_context(session_id,epoch,floor,sequence,sequence_index,ordinal,native_id)
  AS (VALUES(?,?,?,?,?,?,?))`

export function rewindContextBindings(scope: JournalSqlScope, plan: JournalRewindMembership) {
  return [
    ...scope.prefix,
    plan.floor,
    plan.boundary.sequence,
    plan.boundary.sequenceIndex,
    plan.boundary.ordinal,
    plan.nativeId
  ] as const
}

export const JOURNAL_REWIND_JOINS = `LEFT JOIN journal_items owner
  ON owner.session_id=item.session_id AND owner.epoch=item.epoch AND owner.item_id=item.turn_item_id
  LEFT JOIN journal_submission_attempts send
  ON send.session_id=item.session_id AND send.epoch=item.epoch AND send.item_id=item.item_id AND send.current=1`

export const JOURNAL_REWIND_POSITION = '(item.sequence,item.sequence_index,item.ordinal)'
export const JOURNAL_REWIND_BOUNDARY = '(context.sequence,context.sequence_index,context.ordinal)'
const adopted = "send.dispatch_state='accepted' AND send.provider_item_id IS NOT NULL"
export const JOURNAL_REWIND_THREAD = `CASE WHEN ${adopted} THEN send.codex_thread_id ELSE item.codex_thread_id END`
export const JOURNAL_REWIND_NATIVE_TURN = `CASE WHEN ${adopted} THEN send.codex_turn_id ELSE item.codex_turn_id END`

export function rewindMember(scope: JournalRewindScope): string {
  if (scope === 'provider-timeline') {
    return `CASE WHEN item.turn_id IS NOT NULL THEN item.item_id
      WHEN item.turn_scope_kind='turn' THEN item.turn_item_id
      WHEN item.kind='message' AND item.message_role='user' THEN (
        SELECT root.item_id FROM journal_items root INDEXED BY journal_items_opener
        WHERE root.session_id=item.session_id AND root.epoch=item.epoch AND root.hidden=0
          AND root.opener_item_id=item.item_id AND root.opener_item_id IS NOT NULL
          AND root.root=1 AND root.turn_id IS NOT NULL ORDER BY root.ordinal LIMIT 1) END`
  }
  return scope === 'claude'
    ? "CASE WHEN item.turn_scope_kind='turn' THEN item.turn_item_id END"
    : `CASE WHEN (${JOURNAL_REWIND_THREAD})=context.native_id THEN (${JOURNAL_REWIND_NATIVE_TURN})
    WHEN item.turn_scope_kind='turn' THEN owner.provider_turn_id ELSE item.provider_turn_id END`
}

/** Only prefix membership is needed to keep later output; originals never participate. */
export function rewindRetainedTurns(scope: JournalRewindScope): string {
  return `${JOURNAL_REWIND_CONTEXT}, rewind_kept_turns AS MATERIALIZED (
    SELECT DISTINCT ${rewindMember(scope)} AS member FROM rewind_context context
    CROSS JOIN journal_items item INDEXED BY journal_items_visible_position
    ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.hidden=0
      AND item.sequence>context.floor AND ${JOURNAL_REWIND_POSITION}<${JOURNAL_REWIND_BOUNDARY}
      AND (${rewindMember(scope)}) IS NOT NULL)`
}

export function rewindKept(scope: JournalRewindScope, table = 'rewind_kept_turns'): string {
  return `item.hidden=0 AND item.sequence>context.floor
    AND (send.dispatch_state IS NULL OR (send.dispatch_state<>'rejected' AND send.queued=0))
    AND (${JOURNAL_REWIND_POSITION}<${JOURNAL_REWIND_BOUNDARY}
      OR EXISTS(SELECT 1 FROM ${table} WHERE member=(${rewindMember(scope)})))`
}

export function rewindPosition(row: SqliteRow): JournalRewindBoundary {
  return {
    sequence: Number(row.sequence),
    sequenceIndex: Number(row.sequence_index),
    ordinal: Number(row.ordinal)
  }
}
