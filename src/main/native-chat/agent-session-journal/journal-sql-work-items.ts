import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isHistoricalProviderTimelineItem } from '../agent-session-timeline/provider-timeline-history'
import type { JournalSqlScope } from './journal-sql-scope'

/** Independent indexed populations avoid multiplying prompts by unrelated obligations. */
function journalSqlWorkItems(scope: JournalSqlScope) {
  return scope.db
    .prepare(`WITH raw_boundary AS (
      SELECT 'raw' AS selection,item_id FROM journal_items INDEXED BY journal_items_raw_turn_marker
      WHERE session_id=?1 AND epoch=?2 AND turn_marker=1
      ORDER BY sequence DESC,ordinal DESC LIMIT 1),
    visible_boundary AS (
      SELECT 'boundary' AS selection,item_id FROM journal_items INDEXED BY journal_items_turn_marker
      WHERE session_id=?1 AND epoch=?2 AND hidden=0 AND turn_marker=1
      ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1),
    wanted AS (
      SELECT selection,item_id FROM raw_boundary UNION ALL
      SELECT selection,item_id FROM visible_boundary UNION ALL
      SELECT 'pending-prompts',item_id FROM journal_items INDEXED BY journal_items_status_pending
      WHERE session_id=?1 AND epoch=?2 AND hidden=0
        AND kind IN ('approval','question') AND lifecycle_state='pending')
    SELECT wanted.selection,item.item_id,item.sequence,item.sequence_index,item.ordinal,
      item.payload_json,item.wire_version,item.wire_json,item.hidden,item.turn_item_id,item.opener_item_id,
      COALESCE(item.execution_owner,item.owner_fence) AS fence
    FROM wanted CROSS JOIN journal_items item
    WHERE item.session_id=?1 AND item.epoch=?2 AND item.item_id=wanted.item_id`)
    .iterate(...scope.prefix)
}

export function readJournalSqlWorkItems(scope: JournalSqlScope) {
  return [...journalSqlWorkItems(scope)].sort(
    (a, b) =>
      Number(a.sequence) - Number(b.sequence) ||
      Number(a.sequence_index) - Number(b.sequence_index) ||
      Number(a.ordinal) - Number(b.ordinal)
  )
}

function readJournalSqlWorkRelatedItems(scope: JournalSqlScope, ids: readonly string[]) {
  return scope.db
    .prepare(`SELECT wanted.value AS item_id,item.payload_json,item.wire_version,item.wire_json,item.hidden,
      COALESCE(item.execution_owner,item.owner_fence) AS fence
    FROM json_each(?) wanted LEFT JOIN journal_items item
    ON item.session_id=? AND item.epoch=? AND item.item_id=wanted.value`)
    .all(JSON.stringify(ids), ...scope.prefix)
}

function journalSqlWorkDependencies(
  items: AgentJournalRenderItem[],
  read: (id: string) => AgentJournalRenderItem | null | undefined
) {
  const missing = new Set<string>()
  for (const item of items) {
    isHistoricalProviderTimelineItem(item, (id) => {
      const value = read(id)
      if (value === undefined) {
        missing.add(id)
      }
      return value ?? null
    })
  }
  return [...missing]
}

export function hydrateJournalSqlWorkDependencies(
  scope: JournalSqlScope,
  sources: AgentJournalRenderItem[],
  read: (id: string) => AgentJournalRenderItem | null | undefined,
  remember: (rows: ReturnType<typeof readJournalSqlWorkRelatedItems>) => void
) {
  // The shared policy asks for at most the owning turn and its reciprocal opener.
  for (let depth = 0; depth < 2; depth++) {
    const missing = journalSqlWorkDependencies(sources, read)
    if (!missing.length) {
      break
    }
    remember(readJournalSqlWorkRelatedItems(scope, missing))
  }
}
