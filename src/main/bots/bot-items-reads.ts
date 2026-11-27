// Item reads beyond one row: a bot's list with exact counts, links by what they point at, and the rows
// item views need in one round trip.
import {
  type BotItemActor,
  botItemEventId,
  isOpenBotItemStatus,
  type BotItemLinkKind,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import {
  eventRecordOf,
  integer,
  itemRecordOf,
  linkRecordOf,
  optionalInteger,
  statusOf,
  text
} from './bot-items-rows'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotItemEventRecord, BotItemLinkRecord, BotItemRecord } from './bot-items-schema'
import { BotItemsTables } from './bot-items-tables'

export type BotItemListQuery = {
  botId: string
  statuses: readonly BotItemStatus[]
  /** Only these chats' items, counts included. */
  chatIds?: readonly string[]
  /** Only items linking this: `item list --link`. */
  link?: { kind: BotItemLinkKind; ref: string }
  /** Only these items; the counts stay the whole scope's. */
  uids?: readonly string[]
  limit: number
  /** The last row of the previous page. */
  cursor?: { at: number; number: number }
}

export type BotItemClose = { actor: BotItemActor; actsFor: readonly BotRequestAsker[] | null }

export class BotItemsReads extends BotItemsTables {
  /** Links of a kind to any of these refs, across items. */
  linksTo(kind: BotItemLinkKind, refs: readonly string[]): BotItemLinkRecord[] {
    if (refs.length === 0) {
      return []
    }
    return this.db
      .prepare(
        `SELECT * FROM item_links WHERE kind = ? AND ref IN (SELECT value FROM json_each(?))`
      )
      .all(kind, JSON.stringify(refs))
      .flatMap((row) => linkRecordOf(row) ?? [])
  }

  /** Up to `limit` distinct items linking any of these refs, by the ref index: enough to tell
   *  whether any item but one holds them, without reading every link. */
  itemsLinking(kind: BotItemLinkKind, refs: readonly string[], limit: number): string[] {
    if (refs.length === 0) {
      return []
    }
    return this.db
      .prepare(
        `SELECT DISTINCT item_uid FROM item_links WHERE kind = ? AND ref IN (SELECT value FROM json_each(?)) LIMIT ?`
      )
      .all(kind, JSON.stringify(refs), limit)
      .map((row) => String(row.item_uid))
  }

  /** An item and where its work started (its `made` event's `startedIn`), in one call: what a
   *  finished worker's report names. */
  reportFact(uid: string): { item: BotItemRecord; startedIn: string | null } | null {
    const item = this.get(uid)
    if (!item) {
      return null
    }
    const made = this.db
      .prepare(
        "SELECT json_extract(data, '$.startedIn') AS started_in FROM item_events WHERE item_uid = ? AND kind = 'made' ORDER BY id LIMIT 1"
      )
      .get(uid)
    const startedIn = made?.started_in
    return { item, startedIn: typeof startedIn === 'string' && startedIn ? startedIn : null }
  }

  /** Every Dispatch any item links. */
  linkedDispatchRefs(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT ref FROM item_links WHERE kind = 'dispatch'`)
      .all()
      .map((row) => String(row.ref))
  }

  /** The bot's own items, newest change first, with exact counts per status. */
  list(query: BotItemListQuery): {
    items: BotItemRecord[]
    counts: Partial<Record<BotItemStatus, number>>
  } {
    const chat = query.chatIds ? ' AND chat_id IN (SELECT value FROM json_each(?))' : ''
    const link = query.link
      ? ' AND uid IN (SELECT item_uid FROM item_links WHERE kind = ? AND ref = ?)'
      : ''
    const scope = `owner_bot_id = ?${chat}${link}`
    const scopeArgs = [
      query.botId,
      ...(query.chatIds ? [JSON.stringify(query.chatIds)] : []),
      ...(query.link ? [query.link.kind, query.link.ref] : [])
    ]
    const counts: Partial<Record<BotItemStatus, number>> = {}
    for (const row of this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM items WHERE ${scope} GROUP BY status`)
      .all(...scopeArgs)) {
      counts[statusOf(row.status)] = Number(row.count ?? 0)
    }
    // Named items are looked up by uid (CROSS JOIN keeps that order), not found in the bot's scan.
    const from = query.uids
      ? 'json_each(?) AS named CROSS JOIN items WHERE items.uid = named.value AND'
      : 'items WHERE'
    const cursor = query.cursor
      ? ' AND (last_activity_at < ? OR (last_activity_at = ? AND number < ?))'
      : ''
    const items = this.db
      .prepare(
        `SELECT items.* FROM ${from} ${scope}
           AND status IN (SELECT value FROM json_each(?))${cursor}
         ORDER BY last_activity_at DESC, number DESC LIMIT ?`
      )
      .all(
        ...(query.uids ? [JSON.stringify(query.uids)] : []),
        ...scopeArgs,
        JSON.stringify(query.statuses),
        ...(query.cursor ? [query.cursor.at, query.cursor.at, query.cursor.number] : []),
        query.limit
      )
      .map(itemRecordOf)
    return { items, counts }
  }

  /** Every Needs you item's bot, last activity and snooze, so the bot list counts what needs the owner. */
  needsYou(): { botId: string; lastActivityAt: number; snoozedUntil: number | null }[] {
    return this.db
      .prepare(
        `SELECT owner_bot_id, last_activity_at, snoozed_until FROM items WHERE status = 'needs_you'`
      )
      .all()
      .map((row) => ({
        botId: String(row.owner_bot_id),
        lastActivityAt: Number(row.last_activity_at),
        snoozedUntil: optionalInteger(row, 'snoozed_until')
      }))
  }

  /** The close each item's `closedAt` names: who made it, and whom its chat acted for when it says.
   *  Seeks each by item and time on the status-event index, so later events never grow the read. */
  closes(items: readonly { uid: string; closedAt: number }[]): Record<string, BotItemClose> {
    const closes: Record<string, BotItemClose> = {}
    for (const row of this.db
      .prepare(
        `SELECT * FROM item_events WHERE id IN (SELECT (SELECT id FROM item_events
           WHERE item_uid = json_extract(named.value, '$.uid') AND kind = 'status'
             AND created_at = json_extract(named.value, '$.closedAt')
             AND json_extract(data, '$.to') IN ('done', 'canceled')
           ORDER BY id DESC LIMIT 1) FROM json_each(?) AS named)`
      )
      .all(JSON.stringify(items))) {
      const event = eventRecordOf(row)
      const { actsFor } = event.data
      closes[event.itemUid] = {
        actor: event.actor,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the host writes actsFor, from a turn's askers.
        actsFor: Array.isArray(actsFor) ? (actsFor as BotRequestAsker[]) : null
      }
    }
    return closes
  }

  /** What item views need, for many items in one round trip: rows, links, Needs you questions, waits
   *  and the newest event anyone but the owner made. */
  viewRows(
    uids: readonly string[],
    /** Also each open item's waiting ask, which reads its events: for its own view only. */
    withWaitingAsks = false
  ): {
    items: BotItemRecord[]
    links: Record<string, BotItemLinkRecord[]>
    questions: Record<string, BotItemEventRecord>
    /** Waiting items' status events, whose note says what each waits on. */
    waits: Record<string, BotItemEventRecord>
    othersLast: Record<string, number>
    waitingAsks: Record<string, string>
  } {
    const ids = JSON.stringify(uids)
    const rows = this.db
      .prepare('SELECT * FROM items WHERE uid IN (SELECT value FROM json_each(?))')
      .all(ids)
    const items = rows.map(itemRecordOf)
    const othersLast: Record<string, number> = {}
    for (const row of rows) {
      const id = integer(row, 'others_last_event_id')
      if (id > 0) {
        othersLast[text(row, 'uid')] = id
      }
    }
    const links: Record<string, BotItemLinkRecord[]> = {}
    for (const row of this.db
      .prepare(
        `SELECT * FROM item_links WHERE item_uid IN (SELECT value FROM json_each(?))
          ORDER BY added_event, ref`
      )
      .all(ids)) {
      const record = linkRecordOf(row)
      if (record) {
        ;(links[record.itemUid] ??= []).push(record)
      }
    }
    const questions: Record<string, BotItemEventRecord> = {}
    const waits: Record<string, BotItemEventRecord> = {}
    const questionIds = new Set(items.flatMap((item) => item.questionEvent ?? []))
    const waitIds = items.flatMap((item) =>
      item.status === 'waiting' ? (item.waitEvent ?? []) : []
    )
    for (const row of this.db
      .prepare('SELECT * FROM item_events WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...questionIds, ...waitIds]))) {
      const event = eventRecordOf(row)
      ;(questionIds.has(event.id) ? questions : waits)[event.itemUid] = event
    }
    const waitingAsks: Record<string, string> = {}
    for (const item of withWaitingAsks ? items : []) {
      const ask = isOpenBotItemStatus(item.status) ? this.waitingAsk(item) : null
      if (ask !== null) {
        waitingAsks[item.uid] = botItemEventId(ask)
      }
    }
    return { items, links, questions, waits, othersLast, waitingAsks }
  }

  showRows(
    uid: string,
    afterId: number,
    limit: number
  ): {
    rows: ReturnType<BotItemsReads['viewRows']>
    events: BotItemEventRecord[]
  } {
    // A version must describe the history the caller could have read.
    this.db.exec('BEGIN')
    try {
      return { rows: this.viewRows([uid]), events: this.events(uid, afterId, limit) }
    } finally {
      this.db.exec('ROLLBACK')
    }
  }
}
