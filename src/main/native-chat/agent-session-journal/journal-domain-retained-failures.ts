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
  const failed = db.prepare(`SELECT payload_json, queue_failed_at, queue_failure_witnessed_through
    FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND queue_failed_at>0`)
  return itemIds.flatMap((itemId) => {
    const row = failed.get(...prefix, itemId)
    if (!row) {
      return []
    }
    const failedAt = Number(row.queue_failed_at)
    return [
      {
        itemId,
        item: JSON.parse(String(row.payload_json)),
        at: Math.max(
          failedAt,
          boundary > Number(row.queue_failure_witnessed_through) ? boundary : 0
        ),
        reports: reportCount(db, target, itemId)
      }
    ]
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
