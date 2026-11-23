// The sends an operation window reads: every one, or for a window through its anchored turns only
// those it can hold, each found by index.
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import type { JournalSqlScope } from './journal-sql-scope'

export type Send = {
  messageId: string
  itemId: string
  ordinal: number
  dispatchState: string
  recovered: boolean
  providerItemId: string | null
  queuedMessageId: string | null
  submittedSequence: number | null
  /** Where its opener, the provider's row for it and the turn it was answered in sit. */
  positions: number[]
}

/** The sends an operation names: its own, and the one that consumed it as a queued card. */
export function operationSends(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors
): Send[] {
  const ids = (anchors.operationIds ?? []).flatMap((operationId) => [
    operationId,
    ...(journalDomainQueueRow(scope.db, scope, operationId)?.card.consumedAs ?? [])
  ])
  return sendHeads(scope, 'AND message_id IN (SELECT value FROM json_each(?))', [
    JSON.stringify(ids)
  ])
}

/** The sends whose opener row, or the head they were sent at, sits in `[start, end)`. */
export function windowSends(scope: JournalSqlScope, start: number, end: number): Send[] {
  return [
    ...sendHeads(
      scope,
      `AND item_id IN (SELECT item_id FROM journal_items INDEXED BY journal_items_visible_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? AND sequence<?)`,
      [...scope.prefix, start, end]
    ),
    ...sendHeads(scope, 'AND submitted_sequence>=? AND submitted_sequence<?', [start, end])
  ]
}

export function withSends(sends: readonly Send[], more: readonly Send[]): Send[] {
  const known = new Set(sends.map((send) => send.messageId))
  const added = more.filter((send) => !known.has(send.messageId) && known.add(send.messageId))
  return [...sends, ...added].toSorted((a, b) => a.ordinal - b.ordinal)
}

/** Every current send's selectors (or those `where` picks) and where its rows sit; payloads are
 *  decoded only for those kept. */
export function sendHeads(
  scope: JournalSqlScope,
  where = '',
  params: readonly (string | number)[] = []
): Send[] {
  const at = (column: string) => `(SELECT sequence FROM journal_items item
    WHERE item.session_id=send.session_id AND item.epoch=send.epoch AND item.item_id=${column}
    AND item.hidden=0)`
  return scope.db
    .prepare(`SELECT message_id,item_id,ordinal,dispatch_state,recovered,provider_item_id,submitted_sequence,
    (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedMessageId') END) AS queued_message_id,
    ${at('send.item_id')} AS opener_sequence,${at('send.provider_item_id')} AS provider_sequence,
    ${at("(CASE WHEN json_valid(send.payload_json) THEN json_extract(send.payload_json,'$.answeredInTurn.turnItemId') END)")} AS answered_sequence
    FROM journal_submission_attempts send WHERE session_id=? AND epoch=? AND current=1 ${where}
    ORDER BY ordinal`)
    .all(...scope.prefix, ...params)
    .map((row) => {
      const read = scope.examined(row)
      return {
        messageId: String(read.message_id),
        itemId: String(read.item_id),
        ordinal: Number(read.ordinal),
        dispatchState: String(read.dispatch_state),
        recovered: Number(read.recovered) === 1,
        providerItemId: read.provider_item_id === null ? null : String(read.provider_item_id),
        queuedMessageId: read.queued_message_id === null ? null : String(read.queued_message_id),
        submittedSequence:
          read.submitted_sequence === null ? null : Number(read.submitted_sequence),
        positions: [read.opener_sequence, read.provider_sequence, read.answered_sequence].flatMap(
          (value) => (value === null || value === undefined ? [] : [Number(value)])
        )
      }
    })
}

export function readSend(scope: JournalSqlScope, messageId: string): AgentJournalSubmission {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(...scope.prefix, messageId)
  if (!row) {
    throw new Error('journal send left between its selector and payload reads')
  }
  return scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
}
