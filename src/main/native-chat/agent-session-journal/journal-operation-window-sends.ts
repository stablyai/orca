// The sends an operation window reads: every one, or for a window through its anchored turns or of
// its newest turns only those it can hold, each found by index.
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  SEND_ANSWERED_TURN_SQL,
  SEND_PLACE_ROW_SQL,
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

/** The ids of the rows in `[start, end)` a send can sit on, by the index that holds only those, so a
 *  turn's tool calls are never listed. Takes the session, epoch, start and end. */
export function windowPlaceRows(column: string): string {
  return `(SELECT ${column} FROM journal_items INDEXED BY journal_items_send_place
      WHERE session_id=? AND epoch=? AND ${SEND_PLACE_ROW_SQL} AND sequence>=? AND sequence<?)`
}

/** The sends whose opener row, provider row or answering turn row, or the head they were sent at,
 *  sits in `[start, end)`. */
export function windowSends(scope: JournalSqlScope, start: number, end: number): Send[] {
  return placedSends(scope, start, end) ?? []
}

/** As `windowSends`, or null when one lookup lists `limit` sends: a key shared that widely is the
 *  whole read's to answer. Each lookup stops at `limit`. */
export function placedSends(
  scope: JournalSqlScope,
  start: number,
  end: number,
  limit?: number
): Send[] | null {
  if (limit !== undefined && crowded(scope, start, end)) {
    return null
  }
  const range = [...scope.prefix, start, end]
  return capped(limit, [
    () =>
      sendHeads(
        scope,
        `AND item_id IN ${windowPlaceRows('item_id')}`,
        range,
        'journal_submission_item',
        limit
      ),
    () =>
      sendHeads(
        scope,
        `AND provider_item_id IN ${windowPlaceRows('item_id')}`,
        range,
        'journal_submission_provider_item',
        limit
      ),
    () =>
      sendHeads(
        scope,
        // `+item_id` drops the column's TEXT affinity, so the comparison keys on the indexed expression.
        `AND ${SEND_ANSWERED_TURN_SQL} IN ${windowPlaceRows('+item_id')}`,
        range,
        'journal_submission_answered_turn',
        limit
      ),
    () =>
      sendHeads(
        scope,
        'AND submitted_sequence>=? AND submitted_sequence<?',
        [start, end],
        'journal_submission_submitted',
        limit
      )
  ])
}

/** The lookups' sends once each, or null when one listed `limit` (so it may have stopped short). */
function capped(limit: number | undefined, lookups: (() => Send[])[]): Send[] | null {
  const byId = new Map<string, Send>()
  for (const lookup of lookups) {
    const sends = lookup()
    if (limit !== undefined && sends.length >= limit) {
      return null
    }
    sends.forEach((send) => byId.set(send.messageId, send))
  }
  return [...byId.values()]
}

/** Most visible non-tool rows a newest-turns window lists to place its sends; past it, the whole read. */
const RECENT_ROW_CAP = 1024

/** Whether `[start, end)` holds more rows a send can sit on than `RECENT_ROW_CAP`, counted by index
 *  and stopping one past the cap. */
function crowded(scope: JournalSqlScope, start: number, end: number): boolean {
  const counted = scope.db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM journal_items INDEXED BY journal_items_send_place
      WHERE session_id=? AND epoch=? AND ${SEND_PLACE_ROW_SQL} AND sequence>=? AND sequence<? LIMIT ?)`)
    .get(...scope.prefix, start, end, RECENT_ROW_CAP + 1)
  return Number(counted?.n) > RECENT_ROW_CAP
}

/** Most sends a newest-turns window reads by index for one walk of families; past it, the whole read. */
export const RECENT_FAMILY_CAP = 64

/** A walk of families that settles on the whole read: past `cap` sends, or at one `older` send. */
export type FamilyBound = { cap: number; older: (send: Send) => boolean }

/** `sends` with `more`, once each by message id, and every send sharing a provider id or queued card
 *  with one of them (attribution reads the first or last of those), each found by index. */
export function withSends(
  scope: JournalSqlScope,
  sends: readonly Send[],
  more: readonly Send[]
): Send[] {
  return boundedSends(scope, sends, more) ?? [...sends]
}

/** As `withSends`, or null as soon as `bound` settles on the whole read: at an `older` send, or once
 *  the walk adds more than `cap` sends past `sends` and `more`. Each lookup lists a bounded number of
 *  sends, so the walk's work is bounded however large a family grows. */
export function boundedSends(
  scope: JournalSqlScope,
  sends: readonly Send[],
  more: readonly Send[],
  bound?: FamilyBound
): Send[] | null {
  const byId = new Map(sends.map((send) => [send.messageId, send]))
  let added = [...new Map(more.map((send) => [send.messageId, send])).values()].filter(
    (send) => !byId.has(send.messageId)
  )
  const most = bound ? byId.size + added.length + bound.cap : Infinity
  while (added.length > 0) {
    added.forEach((send) => byId.set(send.messageId, send))
    if (bound && (byId.size > most || added.some(bound.older))) {
      return null
    }
    const limit = bound ? most + 1 : undefined
    const providers = [...new Set(added.flatMap((send) => send.providerItemId ?? []))]
    const cards = [...new Set(added.flatMap((send) => send.queuedMessageId ?? []))]
    const related = capped(limit, [
      () =>
        providers.length > 0
          ? sendHeads(
              scope,
              'AND provider_item_id IN (SELECT value FROM json_each(?))',
              [JSON.stringify(providers)],
              'journal_submission_provider_item',
              limit
            )
          : [],
      () =>
        cards.length > 0
          ? sendHeads(
              scope,
              `AND ${SEND_QUEUED_CARD_SQL} IN (SELECT value FROM json_each(?))`,
              [JSON.stringify(cards)],
              'journal_submission_queued_card',
              limit
            )
          : []
    ])
    // Every send a lookup lists is in a walked family, so a full lookup means the walk is past the cap.
    if (related === null) {
      return null
    }
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
  index?: string,
  /** At most this many, in index order rather than by ordinal, so the lookup stops early. */
  limit?: number
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
    ${limit === undefined ? 'ORDER BY ordinal' : `LIMIT ${limit}`}`)
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

/** Anchored by its newest turns and nothing else, so only sends placed in it or unsettled count. */
export function newestTurnsOnly(anchors: JournalOperationWindowAnchors): boolean {
  return (
    anchors.latestTurns !== undefined &&
    !anchors.operationIds?.length &&
    !anchors.itemIds?.length &&
    !anchors.turnIds?.length &&
    !anchors.latestEndedTurn &&
    anchors.afterSequence === undefined &&
    anchors.observedSince === undefined
  )
}

/** The sends a window starts from: the anchored operations' through anchored turns, the unsettled
 *  ones for the newest turns alone (null past the cap: the whole read answers), else every send. */
export function seedSends(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors,
  recent: boolean
): Send[] | null {
  if (anchors.throughAnchoredTurns === true) {
    return operationSends(scope, anchors)
  }
  return recent ? unsettledSends(scope) : sendHeads(scope)
}

/** Every send still handed over and unanswered (pending, or unknown and not recovered), wherever it
 *  sits, by the index that keeps exactly those: a recovered one is read only when the window holds it.
 *  The sends sharing a provider id or queued card with them are the caller's to add. */
function unsettledSends(scope: JournalSqlScope): Send[] | null {
  const unsettled = "AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))"
  const limit = RECENT_FAMILY_CAP + 1
  return capped(limit, [
    () => sendHeads(scope, unsettled, [], 'journal_submission_recovery', limit)
  ])
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
