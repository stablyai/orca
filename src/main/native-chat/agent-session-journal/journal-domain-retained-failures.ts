import type Database from '../../sqlite/sync-database'
import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

type Target = { sessionId: string; epoch: string }

export type RetainedFailure = {
  itemId: string
  item: AgentJournalRenderItem
  at: number
  reports: number
}

/** Only known, unchanged replacement turns carry failure chronology across the rewrite. */
export function retainedFailures(
  db: Database.Database,
  target: Target,
  itemIds: readonly string[],
  boundary: number
): RetainedFailure[] {
  const prefix = [target.sessionId, target.epoch] as const
  return db
    .prepare(`SELECT item.item_id,item.payload_json,item.queue_failed_at,
      item.queue_failure_witnessed_through FROM json_each(?) wanted CROSS JOIN journal_items item
    WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.queue_failed_at>0`)
    .all(JSON.stringify(itemIds), ...prefix)
    .map((row) => {
      const itemId = String(row.item_id)
      const failedAt = Number(row.queue_failed_at)
      return {
        itemId,
        item: JSON.parse(String(row.payload_json)),
        at: Math.max(
          failedAt,
          boundary > Number(row.queue_failure_witnessed_through) ? boundary : 0
        ),
        reports: reportCount(db, target, itemId)
      }
    })
}

export function restoreRetainedFailures(
  db: Database.Database,
  target: Target,
  retained: readonly RetainedFailure[]
): void {
  const prefix = [target.sessionId, target.epoch] as const
  const kept = db.prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND queue_failed_at>0`)
  for (const { itemId, item, at, reports } of retained) {
    const row = kept.get(...prefix, itemId)
    const next: AgentJournalRenderItem | undefined = row
      ? JSON.parse(String(row.payload_json))
      : undefined
    if (
      !next ||
      !isDeepStrictEqual(item.body, next.body) ||
      !isDeepStrictEqual(item.turnScope, next.turnScope) ||
      !isDeepStrictEqual(agentJournalLinkageFields(item), agentJournalLinkageFields(next)) ||
      reportCount(db, target, itemId) !== reports
    ) {
      continue
    }
    db.prepare(`UPDATE journal_items SET queue_failed_at=?, queue_failure_witnessed_through=(
        SELECT queue_failure_boundary FROM journal_chat_state WHERE session_id=? AND epoch=?)
      WHERE session_id=? AND epoch=? AND item_id=?`).run(at, ...prefix, ...prefix, itemId)
  }
}

function reportCount(db: Database.Database, target: Target, turnItemId: string): number {
  return Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
      AND queue_failure_report_turn_item_id=?`)
      .get(target.sessionId, target.epoch, turnItemId)!.n
  )
}
