import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  JOURNAL_REWIND_CONTEXT,
  JOURNAL_REWIND_JOINS,
  JOURNAL_REWIND_NATIVE_TURN,
  JOURNAL_REWIND_THREAD,
  rewindMember,
  rewindPosition,
  rewindContextBindings,
  rewindRetainedTurns,
  rewindKept,
  type JournalRewindMembership
} from './journal-domain-rewind-membership'

export type JournalRewindSelection = { itemId: string; provider: string; nativeId: string }
export type JournalRewindCut = {
  floor: number
  providerItemId: string
} & (
  | { beforeTurnId: string; keptTurnId: string | null }
  | { beforeMessage: { sessionId: string; uuid: string } }
)

/** Provider indexes find the boundary; only its fixed-size plan crosses the reader channel. */
export function planJournalDomainRewindCut(scope: JournalSqlScope, target: JournalRewindSelection) {
  const { db, prefix } = scope
  const floor = Number(
    db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
    INDEXED BY journal_items_context_clear
    WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...prefix)!.sequence ?? 0
  )
  const selected = db
    .prepare(`SELECT item.sequence,item.sequence_index,item.ordinal,
    CASE WHEN send.dispatch_state='accepted' THEN COALESCE(send.provider_item_id,item.item_id)
      ELSE item.item_id END AS provider_item_id
    FROM journal_items item ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=? AND item.epoch=? AND item.item_id=? AND item.hidden=0 AND item.sequence>?`)
    .get(...prefix, target.itemId, floor)
  if (!selected) {
    return null
  }
  scope.examined(selected)
  const providerItemId = String(selected.provider_item_id)
  const key = parseAgentJournalItemKey(providerItemId)
  const claude = key?.provider === 'claude' && target.provider === 'claude'
  if (
    !claude &&
    (key?.provider !== 'codex' || target.provider !== 'codex' || key.threadId !== target.nativeId)
  ) {
    return null
  }
  const membership: JournalRewindMembership = {
    floor,
    boundary: rewindPosition(selected),
    nativeId: target.nativeId,
    claude
  }
  if (claude && key?.provider === 'claude') {
    const cut: JournalRewindCut = {
      floor,
      providerItemId,
      beforeMessage: { sessionId: key.sessionId, uuid: key.uuid }
    }
    return { cut, membership }
  }
  if (key?.provider !== 'codex') {
    return null
  }
  const boundary = db
    .prepare(`${JOURNAL_REWIND_CONTEXT}, candidates AS (
    SELECT item_id FROM journal_items INDEXED BY journal_items_codex_turn
      WHERE session_id=? AND epoch=? AND hidden=0 AND codex_thread_id=? AND codex_turn_id=?
    UNION SELECT item_id FROM journal_submission_attempts INDEXED BY journal_submission_codex_turn
      WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='accepted' AND codex_thread_id=? AND codex_turn_id=?
    UNION SELECT item_id FROM journal_items INDEXED BY journal_items_provider_turn
      WHERE session_id=? AND epoch=? AND hidden=0 AND provider_turn_id=?
    UNION SELECT item.item_id FROM journal_items owner INDEXED BY journal_items_provider_turn
      CROSS JOIN journal_items item INDEXED BY journal_items_stop_turn
      WHERE owner.session_id=? AND owner.epoch=? AND owner.provider_turn_id=?
        AND item.session_id=owner.session_id AND item.epoch=owner.epoch AND item.hidden=0
        AND item.turn_item_id=owner.item_id AND item.turn_item_id IS NOT NULL)
    SELECT item.sequence,item.sequence_index,item.ordinal FROM rewind_context context
    CROSS JOIN candidates CROSS JOIN journal_items item ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.item_id=candidates.item_id
      AND item.hidden=0 AND item.sequence>context.floor AND (${rewindMember(false)})=?
    ORDER BY item.sequence,item.sequence_index,item.ordinal LIMIT 1`)
    .get(
      ...rewindContextBindings(scope, membership),
      ...prefix,
      key.threadId,
      key.turnId,
      ...prefix,
      key.threadId,
      key.turnId,
      ...prefix,
      key.turnId,
      ...prefix,
      key.turnId,
      key.turnId
    )
  if (!boundary) {
    return null
  }
  scope.examined(boundary)
  membership.boundary = rewindPosition(boundary)
  const last = db
    .prepare(`${rewindRetainedTurns(false)}, candidates AS (
    SELECT item_id FROM journal_items INDEXED BY journal_items_codex_turn
      WHERE session_id=? AND epoch=? AND hidden=0 AND codex_thread_id=? AND codex_turn_id IS NOT NULL
    UNION SELECT item_id FROM journal_submission_attempts INDEXED BY journal_submission_codex_turn
      WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='accepted' AND codex_thread_id=?),
    first_occurrences AS (
      SELECT ${JOURNAL_REWIND_NATIVE_TURN} AS turn_id,item.sequence,item.sequence_index,item.ordinal,
        ROW_NUMBER() OVER (PARTITION BY ${JOURNAL_REWIND_NATIVE_TURN}
          ORDER BY item.sequence,item.sequence_index,item.ordinal) AS occurrence
      FROM rewind_context context CROSS JOIN candidates CROSS JOIN journal_items item ${JOURNAL_REWIND_JOINS}
      WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.item_id=candidates.item_id
        AND item.hidden=0 AND (${JOURNAL_REWIND_THREAD})=context.native_id
        AND (item.sequence<=context.floor OR (${rewindKept(false)})))
    SELECT turn_id FROM first_occurrences WHERE occurrence=1
    ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
    .get(
      ...rewindContextBindings(scope, membership),
      ...prefix,
      key.threadId,
      ...prefix,
      key.threadId
    )
  if (last) {
    scope.examined(last)
  }
  const cut: JournalRewindCut = {
    floor,
    providerItemId,
    beforeTurnId: key.turnId,
    keptTurnId: last ? String(last.turn_id) : null
  }
  return { cut, membership }
}
