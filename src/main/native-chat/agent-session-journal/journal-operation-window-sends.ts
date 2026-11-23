// The sends an operation window reads: every one, or for a window through its anchored turns only
// those it can hold, each found by index.
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  SEND_ANSWERED_TURN_SQL,
  SEND_QUEUED_CARD_SQL
} from './database/journal-submission-window-indexes'

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
  /** Its answering turn row's position, when the send names it. */
  answeredSequence: number | null
}

/** The sends an operation names: its own, every send that carried it as a queued card, and the one
 *  that consumed the card. Each read is pinned to its index, so none visits every send. */
export function operationSends(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors
): Send[] {
  const operationIds = anchors.operationIds ?? []
  const ids = operationIds.flatMap((operationId) => {
    const consumedAs = journalDomainQueueRow(scope.db, scope, operationId)?.card.consumedAs
    return consumedAs ? [operationId, consumedAs] : [operationId]
  })
  return withSends(
    scope,
    [],
    [
      ...sendHeads(
        scope,
        'AND message_id IN (SELECT value FROM json_each(?))',
        [JSON.stringify(ids)],
        'journal_submission_head'
      ),
      ...sendHeads(
        scope,
        `AND ${SEND_QUEUED_CARD_SQL} IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(operationIds)],
        'journal_submission_queued_card'
      )
    ]
  )
}

/** The sends whose opener row, provider row or answering turn row, or the head they were sent at,
 *  sits in `[start, end)`. */
export function windowSends(scope: JournalSqlScope, start: number, end: number): Send[] {
  const rows = (
    column: string
  ) => `(SELECT ${column} FROM journal_items INDEXED BY journal_items_visible_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? AND sequence<?)`
  const range = [...scope.prefix, start, end]
  return [
    ...sendHeads(scope, `AND item_id IN ${rows('item_id')}`, range, 'journal_submission_item'),
    ...sendHeads(
      scope,
      `AND provider_item_id IN ${rows('item_id')}`,
      range,
      'journal_submission_provider_item'
    ),
    ...sendHeads(
      scope,
      // `+item_id` drops the column's TEXT affinity, so the comparison keys on the indexed expression.
      `AND ${SEND_ANSWERED_TURN_SQL} IN ${rows('+item_id')}`,
      range,
      'journal_submission_answered_turn'
    ),
    ...sendHeads(
      scope,
      'AND submitted_sequence>=? AND submitted_sequence<?',
      [start, end],
      'journal_submission_submitted'
    )
  ]
}

/** `sends` with `more`, once each by message id, and every send sharing a provider id or queued card
 *  with one of them (attribution reads the first or last of those), each found by index. */
export function withSends(
  scope: JournalSqlScope,
  sends: readonly Send[],
  more: readonly Send[]
): Send[] {
  const byId = new Map(sends.map((send) => [send.messageId, send]))
  let added = more.filter((send) => !byId.has(send.messageId))
  while (added.length > 0) {
    added.forEach((send) => byId.set(send.messageId, send))
    const providers = [...new Set(added.flatMap((send) => send.providerItemId ?? []))]
    const cards = [...new Set(added.flatMap((send) => send.queuedMessageId ?? []))]
    const related = [
      ...(providers.length > 0
        ? sendHeads(
            scope,
            'AND provider_item_id IN (SELECT value FROM json_each(?))',
            [JSON.stringify(providers)],
            'journal_submission_provider_item'
          )
        : []),
      ...(cards.length > 0
        ? sendHeads(
            scope,
            `AND ${SEND_QUEUED_CARD_SQL} IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(cards)],
            'journal_submission_queued_card'
          )
        : [])
    ]
    const seen = new Set<string>()
    added = related.filter((send) => {
      const fresh = !byId.has(send.messageId) && !seen.has(send.messageId)
      seen.add(send.messageId)
      return fresh
    })
  }
  return [...byId.values()].toSorted((a, b) => a.ordinal - b.ordinal)
}

/** Every current send's selectors (or those `where` picks) and where its rows sit; payloads are
 *  decoded only for those kept. */
export function sendHeads(
  scope: JournalSqlScope,
  where = '',
  params: readonly (string | number)[] = [],
  index?: string
): Send[] {
  const at = (column: string) => `(SELECT sequence FROM journal_items item
    WHERE item.session_id=send.session_id AND item.epoch=send.epoch AND item.item_id=${column}
    AND item.hidden=0)`
  return scope.db
    .prepare(`SELECT message_id,item_id,ordinal,dispatch_state,recovered,provider_item_id,submitted_sequence,
    (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedMessageId') END) AS queued_message_id,
    ${at('send.item_id')} AS opener_sequence,${at('send.provider_item_id')} AS provider_sequence,
    ${at("(CASE WHEN json_valid(send.payload_json) THEN json_extract(send.payload_json,'$.answeredInTurn.turnItemId') END)")} AS answered_sequence
    FROM journal_submission_attempts send ${index ? `INDEXED BY ${index}` : ''} WHERE session_id=? AND epoch=? AND current=1 ${where}
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
        answeredSequence:
          read.answered_sequence === null || read.answered_sequence === undefined
            ? null
            : Number(read.answered_sequence),
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
