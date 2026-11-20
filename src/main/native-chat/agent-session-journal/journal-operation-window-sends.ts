import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import {
  journalSendAnsweredTurn,
  journalSendQueuedCard
} from './database/journal-submission-placement-indexes'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalOperationWindowAnchors } from './journal-domain-operation-window'
import type { JournalSqlScope } from './journal-sql-scope'

// The sends an operation window can hold, each found by a key rather than by reading every send.

export type WindowSend = {
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

/**
 * Every send the window can hold, found by index rather than by reading the chat's every send: the
 * anchored and unanswered ones, those with a row at or after the window's start, and every send
 * sharing a provider id or queued card with one of those. keptSends over them equals keptSends over
 * all the chat's sends, since it keeps no other.
 */
export class WindowSends {
  private readonly known = new Map<string, WindowSend>()
  private readonly askedProviders = new Set<string>()
  private readonly askedCards = new Set<string>()
  private placedFrom: number | null = null

  constructor(private readonly scope: JournalSqlScope) {}

  /** The sends found so far, as the chat orders them. */
  list(): WindowSend[] {
    return [...this.known.values()].sort((a, b) => a.ordinal - b.ordinal)
  }

  load(messageIds: readonly string[]): void {
    const missing = [...new Set(messageIds)].filter((id) => !this.known.has(id))
    for (const send of missing.length > 0 ? sendHeads(this.scope, missing) : []) {
      this.known.set(send.messageId, send)
    }
    this.addSharers()
  }

  /** Adds the sends with a row at or after `start`. */
  placeFrom(start: number | null): void {
    if (start === null || (this.placedFrom !== null && start >= this.placedFrom)) {
      return
    }
    const until = this.placedFrom ?? Number.MAX_SAFE_INTEGER
    this.placedFrom = start
    this.load(placedSends(this.scope, start, until))
  }

  /** Every send sharing a provider id or queued card with a found one, until none is new. */
  private addSharers(): void {
    const fresh = (values: (string | null)[], asked: Set<string>) =>
      [...new Set(values)].filter((value): value is string => {
        if (value === null || asked.has(value)) {
          return false
        }
        asked.add(value)
        return true
      })
    const sends = [...this.known.values()]
    const providers = fresh(
      sends.map((send) => send.providerItemId),
      this.askedProviders
    )
    const cards = fresh(
      sends.map((send) => send.queuedMessageId),
      this.askedCards
    )
    if (providers.length > 0 || cards.length > 0) {
      this.load(sharingSends(this.scope, providers, cards))
    }
  }
}

// Sends by each key, the keys driving the loop (CROSS JOIN keeps that order): matched the other way
// round, SQLite walks every send of the chat and probes the keys.
const SEND_KEYS = {
  item: 'send.item_id',
  provider: 'send.provider_item_id',
  message: 'send.message_id',
  answered: journalSendAnsweredTurn('send.payload_json'),
  card: journalSendQueuedCard('send.payload_json')
}
type SendKey = keyof typeof SEND_KEYS

/** Sends whose key is one of a JSON array's values. */
const sendsByValues = (key: SendKey) => `SELECT send.message_id FROM json_each(?) value
  CROSS JOIN journal_submission_attempts send
  WHERE send.session_id=? AND send.epoch=? AND send.current=1 AND ${SEND_KEYS[key]}=value.value`

/** Sends whose key is a visible row's id in [start, until). `+` drops the id's TEXT affinity, which
 *  would bar the payload expression indexes. */
const sendsByRows = (key: SendKey) => `SELECT send.message_id
  FROM journal_items item INDEXED BY journal_items_visible_position
  CROSS JOIN journal_submission_attempts send
  WHERE item.session_id=? AND item.epoch=? AND item.hidden=0 AND item.sequence>=? AND item.sequence<?
  AND send.session_id=item.session_id AND send.epoch=item.epoch AND send.current=1
  AND ${SEND_KEYS[key]}=+item.item_id`

function messageIds(scope: JournalSqlScope, rows: SqliteRow[]): string[] {
  return rows.map((row) => String(scope.examined(row).message_id))
}

/** The anchored sends (by row or provider id, by id, card or the card's consumption) and every
 *  send still unanswered. */
export function seedSends(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors,
  consumed: readonly string[]
): string[] {
  const rows = JSON.stringify(anchors.itemIds ?? [])
  const operations = JSON.stringify(anchors.operationIds ?? [])
  return messageIds(
    scope,
    scope.db
      .prepare(`${sendsByValues('item')} UNION ${sendsByValues('provider')}
      UNION ${sendsByValues('message')} UNION ${sendsByValues('card')}
      UNION SELECT message_id FROM journal_submission_attempts INDEXED BY journal_submission_recovery
      WHERE session_id=? AND epoch=? AND current=1
      AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0))`)
      .all(
        rows,
        ...scope.prefix,
        rows,
        ...scope.prefix,
        JSON.stringify([...(anchors.operationIds ?? []), ...consumed]),
        ...scope.prefix,
        operations,
        ...scope.prefix,
        ...scope.prefix
      )
  )
}

/** The sends whose opener, provider row or answering turn sits in [start, until). */
function placedSends(scope: JournalSqlScope, start: number, until: number): string[] {
  const range = [...scope.prefix, start, until]
  return messageIds(
    scope,
    scope.db
      .prepare(`${sendsByRows('item')} UNION ${sendsByRows('provider')}
      UNION ${sendsByRows('answered')}`)
      .all(...range, ...range, ...range)
  )
}

function sharingSends(
  scope: JournalSqlScope,
  providers: readonly string[],
  cards: readonly string[]
): string[] {
  return messageIds(
    scope,
    scope.db
      .prepare(`${sendsByValues('provider')} UNION ${sendsByValues('card')}`)
      .all(JSON.stringify(providers), ...scope.prefix, JSON.stringify(cards), ...scope.prefix)
  )
}

/** The named sends' selectors and where their rows sit; payloads are decoded only for those kept. */
function sendHeads(scope: JournalSqlScope, ids: readonly string[]): WindowSend[] {
  const at = (column: string) => `(SELECT sequence FROM journal_items item
    WHERE item.session_id=send.session_id AND item.epoch=send.epoch AND item.item_id=${column}
    AND item.hidden=0)`
  return scope.db
    .prepare(`SELECT message_id,item_id,ordinal,dispatch_state,recovered,provider_item_id,submitted_sequence,
    ${journalSendQueuedCard()} AS queued_message_id,
    ${at('send.item_id')} AS opener_sequence,${at('send.provider_item_id')} AS provider_sequence,
    ${at(journalSendAnsweredTurn('send.payload_json'))} AS answered_sequence
    FROM journal_submission_attempts send WHERE session_id=? AND epoch=? AND current=1
    AND message_id IN (SELECT value FROM json_each(?))`)
    .all(...scope.prefix, JSON.stringify(ids))
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

/** The latest consumption of each anchored operation's queued card. */
export function consumedCards(scope: JournalSqlScope, anchors: JournalOperationWindowAnchors): string[] {
  return (anchors.operationIds ?? []).flatMap(
    (operationId) => journalDomainQueueRow(scope.db, scope, operationId)?.card.consumedAs ?? []
  )
}

