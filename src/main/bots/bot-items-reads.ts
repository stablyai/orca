// Item reads beyond one row: a bot's list with exact counts, links by what they point at, and the rows
// item views need in one round trip.
import type { BotItemLinkKind, BotItemStatus } from '../../shared/bots/bot-items'
import {
  eventRecordOf,
  integer,
  itemRecordOf,
  linkRecordOf,
  optionalInteger,
  statusOf,
  text
} from './bot-items-rows'
import type { BotItemEventRecord, BotItemLinkRecord, BotItemRecord } from './bot-items-schema'
import { BotItemsTables } from './bot-items-tables'

export type BotItemListQuery = {
  botId: string
  statuses: readonly BotItemStatus[]
  /** Only these chats' items, counts included. */
  chatIds?: readonly string[]
  /** Only items linking this: `item list --link`. */
  link?: { kind: BotItemLinkKind; ref: string }
  limit: number
  /** The last row of the previous page. */
  cursor?: { at: number; number: number }
}

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
    const cursor = query.cursor
      ? ' AND (last_activity_at < ? OR (last_activity_at = ? AND number < ?))'
      : ''
    const items = this.db
      .prepare(
        `SELECT * FROM items WHERE ${scope}
           AND status IN (SELECT value FROM json_each(?))${cursor}
         ORDER BY last_activity_at DESC, number DESC LIMIT ?`
      )
      .all(
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

  /** What item views need, for many items in one round trip: rows, links, Needs you questions and
   *  the newest event anyone but the owner made. */
  viewRows(uids: readonly string[]): {
    items: BotItemRecord[]
    links: Record<string, BotItemLinkRecord[]>
    questions: Record<string, BotItemEventRecord>
    othersLast: Record<string, number>
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
    const questionIds = items.flatMap((item) => (item.questionEvent ? [item.questionEvent] : []))
    for (const row of this.db
      .prepare('SELECT * FROM item_events WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(questionIds))) {
      const event = eventRecordOf(row)
      questions[event.itemUid] = event
    }
    return { items, links, questions, othersLast }
  }
}
