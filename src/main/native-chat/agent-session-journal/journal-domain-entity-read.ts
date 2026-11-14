import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalSqlScope } from './journal-sql-scope'
import { readJournalDomainItemDetail } from './journal-domain-item-presentation'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import { readJournalDomainSubmissionBody } from './journal-domain-submission-records'
import type { JournalHistoryOrigin } from './context-epochs/journal-history-origin'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { providerTimelineKeyPart } from '../agent-session-timeline/provider-timeline-identity'

export type JournalDomainEntityRead = Extract<
  JournalSqlPointRead['operation'],
  {
    kind:
      | 'metadata'
      | 'provider-turn-in-namespace'
      | 'saved-item-ids'
      | 'item'
      | 'item-detail'
      | 'submission'
      | 'submission-body'
      | 'acceptance'
      | 'item-provenance'
      | 'has-recorded-item'
      | 'has-items'
      | 'presentation-removed'
      | 'canonical-item-id'
      | 'provider-activity'
      | 'latest-stop'
      | 'turn-removed'
  }
>

/** Named identities and fixed-size head facts come from the ready current epoch. */
export function readJournalDomainEntity(
  scope: JournalSqlScope,
  operation: JournalDomainEntityRead
): JournalSqlPointReadResult {
  const { db, prefix } = scope
  const canonical = (itemId: string): string => {
    const alias = db
      .prepare(`SELECT item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND provider_item_id=?`)
      .get(...prefix, itemId)
    return alias ? String(alias.item_id) : itemId
  }
  switch (operation.kind) {
    case 'provider-turn-in-namespace': {
      const prefixKey = `p:${providerTimelineKeyPart(operation.namespace)}:`
      return {
        kind: operation.kind,
        present:
          db
            .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_named_turn
          WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id IS NOT NULL
          AND turn_id>=? AND turn_id<? LIMIT 1`)
            .get(...prefix, prefixKey, `${prefixKey.slice(0, -1)};`) !== undefined
      }
    }
    case 'saved-item-ids':
      return {
        kind: operation.kind,
        itemIds: db
          .prepare(`SELECT item.item_id FROM json_each(?) wanted
          CROSS JOIN journal_items item
          WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value
          AND item.hidden=0 ORDER BY wanted.key`)
          .all(JSON.stringify(operation.itemIds), ...prefix)
          .map((row) => String(row.item_id))
      }
    case 'metadata': {
      const head = db
        .prepare(`SELECT last_sequence,retained_sequence,highest_fence,
        last_activity_at,context_boundary,history_origin_json,queue_revision FROM journal_chat_state
        WHERE session_id=? AND epoch=?`)
        .get(...prefix)!
      const sequence = Number(head.last_sequence)
      const historyOrigin: JournalHistoryOrigin | null =
        head.history_origin_json === null ? null : JSON.parse(String(head.history_origin_json))
      return {
        kind: 'metadata',
        cursor: {
          epoch: journalContextEpoch(scope.epoch, Number(head.context_boundary)),
          sequence
        },
        physicalCursor: { epoch: scope.epoch, sequence },
        oldestSequence: Number(head.retained_sequence),
        highestFence: Number(head.highest_fence),
        queueRevision: `${scope.epoch}:${Number(head.queue_revision)}`,
        lastActivityAt: Number(head.last_activity_at),
        historyOrigin
      }
    }
    case 'item':
    case 'item-detail': {
      if (operation.kind === 'item-detail') {
        return {
          kind: operation.kind,
          item: readJournalDomainItemDetail(db, scope, operation.itemId)
        }
      }
      const row = db
        .prepare(`SELECT payload_json FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
        .get(...prefix, operation.itemId)
      const item: AgentJournalRenderItem | null = row ? JSON.parse(String(row.payload_json)) : null
      return { kind: operation.kind, item }
    }
    case 'submission': {
      const row = db
        .prepare(`SELECT payload_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
        .get(...prefix, operation.clientMessageId)
      const submission: AgentJournalSubmission | undefined = row
        ? JSON.parse(String(row.payload_json))
        : undefined
      return { kind: 'submission', submission }
    }
    case 'submission-body':
      return {
        kind: 'submission-body',
        body: readJournalDomainSubmissionBody(
          db,
          { sessionId: scope.sessionId, epoch: scope.epoch },
          operation.clientMessageId
        )
      }
    case 'acceptance': {
      const row = db
        .prepare(`SELECT receipt.payload_json,head.context_boundary
        FROM journal_send_receipts receipt JOIN journal_chat_state head
          ON head.session_id=receipt.session_id AND head.epoch=receipt.epoch
        WHERE receipt.session_id=? AND receipt.epoch=? AND receipt.message_id=?`)
        .get(...prefix, operation.clientMessageId)
      const receipt: AgentJournalAcceptanceReceipt | null = row
        ? JSON.parse(String(row.payload_json))
        : null
      return {
        kind: 'acceptance',
        receipt: receipt && {
          ...receipt,
          cursor: {
            ...receipt.cursor,
            epoch: journalContextEpoch(scope.epoch, Number(row!.context_boundary))
          }
        }
      }
    }
    case 'item-provenance': {
      const alias = db
        .prepare(`SELECT echo_declared,echo_json FROM journal_item_aliases
        WHERE session_id=? AND epoch=? AND provider_item_id=?`)
        .get(...prefix, operation.itemId)
      const row = db
        .prepare(`SELECT owner_fence,execution_owner FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=?`)
        .get(...prefix, canonical(operation.itemId))
      return {
        kind: 'item-provenance',
        provenance: {
          ...(alias?.echo_declared ? { echoOf: JSON.parse(String(alias.echo_json)) } : {}),
          ownerFence: row ? Number(row.owner_fence) : undefined,
          executionOwner:
            row?.execution_owner === null || row?.execution_owner === undefined
              ? undefined
              : Number(row.execution_owner)
        }
      }
    }
    case 'has-recorded-item':
      return {
        kind: 'has-recorded-item',
        recorded:
          db
            .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?
        UNION ALL SELECT 1 FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=? LIMIT 1`)
            .get(...prefix, operation.itemId, ...prefix, operation.itemId) !== undefined
      }
    case 'has-items':
      return {
        kind: 'has-items',
        hasItems:
          db
            .prepare(
              `SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 LIMIT 1`
            )
            .get(...prefix) !== undefined
      }
    case 'presentation-removed': {
      const itemId = canonical(operation.itemId)
      return {
        kind: 'presentation-removed',
        removed:
          db
            .prepare(`SELECT 1 FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?
        UNION ALL SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=1 LIMIT 1`)
            .get(...prefix, itemId, ...prefix, itemId) !== undefined
      }
    }
    case 'canonical-item-id':
      return { kind: 'canonical-item-id', itemId: canonical(operation.itemId) }
    case 'provider-activity': {
      const row = db
        .prepare(`SELECT last_activity_at FROM journal_provider_activity
        WHERE session_id=? AND epoch=? AND fence=?`)
        .get(...prefix, operation.fence)
      return { kind: 'provider-activity', at: row ? Number(row.last_activity_at) : undefined }
    }
    case 'latest-stop': {
      const row = db
        .prepare(`SELECT queue_latest_stop_json FROM journal_chat_state
        WHERE session_id=? AND epoch=?`)
        .get(...prefix)!
      const stop: JournalLatestStop | null =
        row.queue_latest_stop_json === null ? null : JSON.parse(String(row.queue_latest_stop_json))
      return { kind: 'latest-stop', stop }
    }
    case 'turn-removed':
      return {
        kind: 'turn-removed',
        removed:
          db
            .prepare(`SELECT 1 FROM journal_removed_turns
        WHERE session_id=? AND epoch=? AND turn_id=?`)
            .get(...prefix, operation.turnId) !== undefined
      }
  }
}
