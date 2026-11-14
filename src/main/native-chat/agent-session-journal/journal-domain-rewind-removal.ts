import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import { removeJournalDomainItem } from './journal-domain-item-removal'
import { retainedFailures } from './journal-domain-retained-failures'
import {
  JOURNAL_REWIND_CONTEXT,
  JOURNAL_REWIND_JOINS,
  JOURNAL_REWIND_POSITION,
  rewindContextBindings,
  rewindRetainedTurns,
  rewindKept,
  type JournalRewindMembership
} from './journal-domain-rewind-membership'

/** Materialize each selection once; uniform rows share the delete while turn-owned effects stay explicit. */
export function removeJournalDomainRewindSuffix(
  scope: JournalSqlScope,
  plan: JournalRewindMembership,
  floor: number,
  sequence: number,
  failureBoundary: number,
  childBoundary: AgentSessionForkedFrom['childBoundary'] | undefined
) {
  const { db, prefix } = scope
  const bindings = rewindContextBindings(scope, plan)
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS journal_rewind_members(member TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS journal_rewind_removals(
      item_id TEXT PRIMARY KEY,revision INTEGER,sequence INTEGER,sequence_index INTEGER,ordinal INTEGER,
      turn_id TEXT,special INTEGER) WITHOUT ROWID;
    DELETE FROM journal_rewind_members; DELETE FROM journal_rewind_removals`)
  db.prepare(
    `${rewindRetainedTurns(plan.claude)} INSERT INTO journal_rewind_members SELECT member FROM rewind_kept_turns`
  ).run(...bindings)
  const kept = rewindKept(plan.claude, 'temp.journal_rewind_members')
  if (childBoundary?.kind === 'item') {
    const anchor = db
      .prepare(`SELECT sequence,sequence_index,ordinal FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
      .get(...prefix, childBoundary.itemId)
    const survivor =
      anchor &&
      db
        .prepare(`${JOURNAL_REWIND_CONTEXT}
      SELECT item.item_id FROM rewind_context context CROSS JOIN journal_items item INDEXED BY journal_items_visible_position
      ${JOURNAL_REWIND_JOINS}
      WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.hidden=0
        AND ${JOURNAL_REWIND_POSITION}<=(?,?,?) AND (item.sequence<=? OR (${kept}))
      ORDER BY item.sequence DESC,item.sequence_index DESC,item.ordinal DESC LIMIT 1`)
        .get(
          ...bindings,
          Number(anchor.sequence),
          Number(anchor.sequence_index),
          Number(anchor.ordinal),
          floor
        )
    childBoundary = survivor
      ? { kind: 'item', itemId: String(survivor.item_id) }
      : { kind: 'start' }
  }
  const failed = db
    .prepare(`${JOURNAL_REWIND_CONTEXT}
    SELECT item.item_id FROM rewind_context context CROSS JOIN journal_items item INDEXED BY journal_items_turn_marker
    ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.hidden=0
      AND item.turn_marker=1 AND item.queue_failed_at>0 AND (${kept})`)
    .all(...bindings)
  const failures = retainedFailures(
    db,
    scope,
    failed.map((row) => String(row.item_id)),
    failureBoundary
  )
  db.prepare(`${JOURNAL_REWIND_CONTEXT} INSERT INTO journal_rewind_removals
    SELECT item.item_id,item.revision,item.sequence,item.sequence_index,item.ordinal,
      CASE WHEN item.kind='turn' THEN item.turn_id END,
      item.turn_marker=1 OR item.turn_id IS NOT NULL OR item.queue_failure_report_turn_item_id IS NOT NULL
    FROM rewind_context context CROSS JOIN journal_items item ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.sequence>?
      AND NOT (${kept}) AND NOT (substr(item.item_id,1,5)='orca:' AND COALESCE(send.queued,0)=1)`).run(
    ...bindings,
    floor
  )
  const removed = db
    .prepare(`SELECT item_id,turn_id,special FROM journal_rewind_removals
    ORDER BY sequence,sequence_index,ordinal`)
    .all()
  const removedItemIds = removed.map((row) => String(row.item_id))
  const removedTurnIds = removed.flatMap((row) =>
    row.turn_id === null ? [] : [String(row.turn_id)]
  )
  db.prepare(`INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision)
    SELECT ?,?,cut.item_id,MAX(cut.revision,COALESCE(old.revision,0))+1
    FROM journal_rewind_removals cut LEFT JOIN journal_item_tombstones old
      ON old.session_id=? AND old.epoch=? AND old.item_id=cut.item_id WHERE cut.special=0
    ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET revision=excluded.revision`).run(
    ...prefix,
    ...prefix
  )
  db.prepare(`DELETE FROM journal_item_subagent_names WHERE session_id=? AND epoch=?
    AND item_id IN (SELECT item_id FROM journal_rewind_removals WHERE special=0)`).run(...prefix)
  db.prepare(`DELETE FROM journal_items WHERE session_id=? AND epoch=?
    AND item_id IN (SELECT item_id FROM journal_rewind_removals WHERE special=0)`).run(...prefix)
  const items: AgentJournalRenderItem[] = []
  const removedSet = new Set(removedItemIds)
  for (const row of removed) {
    if (row.special) {
      items.push(
        ...removeJournalDomainItem(
          db,
          scope,
          String(row.item_id),
          sequence,
          undefined,
          false
        ).items.filter((item) => !removedSet.has(item.itemId))
      )
    }
  }
  db.exec('DELETE FROM journal_rewind_members; DELETE FROM journal_rewind_removals')
  return { childBoundary, failures, removedItemIds, removedTurnIds, items }
}
