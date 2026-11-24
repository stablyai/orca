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
  const range = [...scope.prefix, start, end]
  return [
    ...sendHeads(
      scope,
      `AND item_id IN ${windowPlaceRows('item_id')}`,
      range,
      'journal_submission_item'
    ),
    ...sendHeads(
      scope,
      `AND provider_item_id IN ${windowPlaceRows('item_id')}`,
      range,
      'journal_submission_provider_item'
    ),
    ...sendHeads(
      scope,
      // `+item_id` drops the column's TEXT affinity, so the comparison keys on the indexed expression.
      `AND ${SEND_ANSWERED_TURN_SQL} IN ${windowPlaceRows('+item_id')}`,
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
  more: readonly Send[],
  /** Stops the walk once a send it reaches settles what the caller needs. */
  until?: (send: Send) => boolean
): Send[] {
  const byId = new Map(sends.map((send) => [send.messageId, send]))
  let added = more.filter((send) => !byId.has(send.messageId))
  while (added.length > 0) {
    added.forEach((send) => byId.set(send.messageId, send))
    if (until && added.some(until)) {
      break
    }
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

/** The unsettled `seed` with its families, or null once a send the window must hold sits before the
 *  `newest` turns: the whole read is cheaper than reading by index the stretch it pins the window to.
 *  Each family member of a held unanswered send is held, so the first older one ends the walk. */
export function recentSends(
  scope: JournalSqlScope,
  seed: Send[],
  operations: ReadonlySet<string>,
  earliest: number | null,
  newest: number,
  anchorsOnly: boolean
): Send[] | null {
  const older = (send: Send) => !anchorsOnly && reachesBefore([send], null, newest)
  if ((earliest ?? Infinity) < newest || seed.some(older)) {
    return null
  }
  const sends = withSends(scope, [], seed, older)
  const held = keptSends(sends, operations, newest, null, anchorsOnly)
  return sends.some(older) || reachesBefore(held, earliest, newest) ? null : sends
}

/** Whether a send the window must hold sits before `first` (by its rows, or the head it was sent at). */
export function reachesBefore(sends: Send[], earliest: number | null, first: number): boolean {
  return (
    (earliest ?? Infinity) < first ||
    sends.some(
      (send) =>
        (send.submittedSequence ?? Infinity) < first || send.positions.some((at) => at < first)
    )
  )
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
 *  ones for the newest turns alone, else every send. */
export function seedSends(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors,
  recent: boolean
): Send[] {
  if (anchors.throughAnchoredTurns === true) {
    return operationSends(scope, anchors)
  }
  return recent ? unsettledSends(scope) : sendHeads(scope)
}

/** Every send still handed over and unanswered (pending, or unknown and not recovered), wherever it
 *  sits, by the index that keeps exactly those: a recovered one is read only when the window holds it.
 *  The sends sharing a provider id or queued card with them are the caller's to add. */
function unsettledSends(scope: JournalSqlScope): Send[] {
  return sendHeads(
    scope,
    "AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))",
    [],
    'journal_submission_recovery'
  )
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

/** Handed over and not answered: its turn is still to be attributed. */
export function unanswered(send: Send): boolean {
  return send.dispatchState === 'pending' || (send.dispatchState === 'unknown' && !send.recovered)
}

/** The sends the window holds: anchored, unanswered or placed in it, with every send sharing a
 *  provider id or queued card with one, since attribution reads the first or last of those. */
export function keptSends(
  sends: readonly Send[],
  operations: ReadonlySet<string>,
  start: number | null,
  end: number | null,
  anchorsOnly: boolean
): Send[] {
  const after = (position: number) =>
    start !== null && position >= start && (end === null || position < end)
  const kept = new Set(
    sends.filter(
      (send) =>
        operations.has(send.messageId) ||
        send.positions.some(after) ||
        (unanswered(send) && (!anchorsOnly || send.positions.every(after)))
    )
  )
  // Each family (sends sharing a provider id or queued card) is walked once, from its first held member.
  const families = new Map<string, Send[]>()
  const family = (send: Send) => [
    ...(send.providerItemId === null ? [] : [`p:${send.providerItemId}`]),
    ...(send.queuedMessageId === null ? [] : [`c:${send.queuedMessageId}`])
  ]
  for (const send of sends) {
    for (const key of family(send)) {
      const members = families.get(key)
      if (members) {
        members.push(send)
      } else {
        families.set(key, [send])
      }
    }
  }
  const frontier = [...kept]
  for (let send = frontier.pop(); send; send = frontier.pop()) {
    for (const key of family(send)) {
      for (const related of families.get(key) ?? []) {
        if (!kept.has(related)) {
          kept.add(related)
          frontier.push(related)
        }
      }
      families.delete(key)
    }
  }
  return sends.filter((send) => kept.has(send))
}
