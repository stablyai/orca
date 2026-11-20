import type Database from '../../sqlite/sync-database'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import { isDeepStrictEqual } from 'node:util'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  isCommand,
  isTurnOrClear,
  reportedTurnItemId,
  settledFailure
} from './queued-messages/journal-queue-failure-policy'

type Target = { sessionId: string; epoch: string }
export type JournalDomainQueueFailure = {
  commandTurn: number
  failedOutcome: number
  failedAt: number
  witnessedThrough: number
  reportTurnItemId: string | null
}

export function journalDomainQueueFailure(
  db: Database.Database,
  target: Target,
  item: AgentJournalRenderItem,
  previous: AgentJournalRenderItem | undefined,
  sequence: number
): JournalDomainQueueFailure {
  const prefix = [target.sessionId, target.epoch] as const
  const command = isCommand(item)
  const failed = settledFailure(item)
  const eligible =
    failed &&
    (!command ||
      db
        .prepare(`SELECT 1 FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND queue_failure_report_turn_item_id=? LIMIT 1`)
        .get(...prefix, item.itemId) !== undefined)
  const prior =
    isTurnOrClear(previous) && eligible
      ? db
          .prepare(`SELECT queue_failed_at, queue_failure_witnessed_through FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=?`)
          .get(...prefix, item.itemId)
      : undefined
  const report = reportedTurnItemId(item)
  const alias =
    report === null
      ? undefined
      : db
          .prepare(`SELECT item_id FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
          .get(...prefix, report)
  return {
    commandTurn: Number(command),
    failedOutcome: Number(failed),
    failedAt: eligible ? Number(prior?.queue_failed_at || sequence) : 0,
    witnessedThrough:
      eligible && isDeepStrictEqual(previous?.body, item.body)
        ? Number(prior?.queue_failure_witnessed_through ?? 0)
        : 0,
    reportTurnItemId: alias ? String(alias.item_id) : report
  }
}

/** A command's own failure holds only while a current agent failure reports for that turn. */
export function refreshJournalDomainQueueFailureReports(
  db: Database.Database,
  target: Target,
  turnItemIds: readonly (string | null)[],
  sequence: number
): void {
  for (const turnItemId of new Set(turnItemIds)) {
    if (turnItemId === null) {
      continue
    }
    const changed = db
      .prepare(`UPDATE journal_items SET queue_failure_witnessed_through=CASE
      WHEN queue_failed_at=0 THEN 0 ELSE queue_failure_witnessed_through END,
      queue_failed_at=CASE WHEN EXISTS(
      SELECT 1 FROM journal_items report WHERE report.session_id=? AND report.epoch=?
        AND report.hidden=0 AND report.queue_failure_report_turn_item_id=journal_items.item_id)
      THEN COALESCE(NULLIF(queue_failed_at,0),?) ELSE 0 END
      WHERE session_id=? AND epoch=? AND item_id=? AND queue_command_turn=1 AND queue_failed_outcome=1`)
      .run(target.sessionId, target.epoch, sequence, target.sessionId, target.epoch, turnItemId)
    if (changed.changes > 0) {
      invalidateJournalDomainQueue(db, target, sequence)
    }
  }
}

/** The tied header group is bounded by the same 200-position construction limit as history. */
export function readJournalDomainQueueFailure(db: Database.Database, target: Target): number {
  const prefix = [target.sessionId, target.epoch] as const
  const rows = db
    .prepare(`WITH newest AS (
      SELECT source.sequence, source.sequence_index FROM journal_items source INDEXED BY journal_items_queue_eligible_turn
      WHERE source.session_id=? AND source.epoch=? AND source.hidden=0 AND source.turn_marker=1
        AND (source.queue_command_turn=0 OR source.queue_failed_outcome=0 OR source.queue_failed_at>0)
      ORDER BY source.sequence DESC, source.sequence_index DESC LIMIT 1)
    SELECT source.item_id, source.queue_failed_at, source.queue_failure_witnessed_through,
      head.queue_failure_boundary FROM newest CROSS JOIN journal_items source
      JOIN journal_chat_state head ON head.session_id=source.session_id AND head.epoch=source.epoch
    WHERE source.session_id=? AND source.epoch=? AND source.hidden=0 AND source.turn_marker=1
      AND source.sequence=newest.sequence AND source.sequence_index=newest.sequence_index
      AND (source.queue_command_turn=0 OR source.queue_failed_outcome=0 OR source.queue_failed_at>0) LIMIT 200`)
    .all(...prefix, ...prefix)
  const winner = rows.reduce<(typeof rows)[number] | undefined>(
    (prior, row) =>
      !prior || String(row.item_id).localeCompare(String(prior.item_id)) > 0 ? row : prior,
    undefined
  )
  const failedAt = Number(winner?.queue_failed_at ?? 0)
  return failedAt === 0
    ? 0
    : Math.max(
        failedAt,
        Number(winner?.queue_failure_boundary ?? 0) >
          Number(winner?.queue_failure_witnessed_through ?? 0)
          ? Number(winner?.queue_failure_boundary)
          : 0
      )
}
