// The item file's transactions and the row-level steps every write shares: appending an event,
// linking, and checking who may write.
import type SyncDatabase from '../sqlite/sync-database'
import {
  BOT_ITEM_LIMITS,
  isOpenBotItemStatus,
  type BotItemActor,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import { BotItemError } from './bot-item-error'
import { linkWords, type BotItemLinkInput } from './bot-items-input'
import { eventRecordOf, itemRecordOf, linkRecordOf } from './bot-items-rows'
import type { BotItemEventRecord, BotItemLinkRecord, BotItemRecord } from './bot-items-schema'

export class BotItemsTables {
  /** The current write's first event, while one runs. */
  private action: number | null = null

  constructor(
    protected readonly db: SyncDatabase,
    /** A newer Orca changed this file: reads only. */
    readonly readOnly: boolean
  ) {}

  dispose(): void {
    this.db.close()
  }

  protected transaction<T>(write: () => T): T {
    if (this.readOnly) {
      throw new BotItemError(
        'items_read_only',
        'Items were updated by a newer Orca; update Orca to change them.'
      )
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.action = null
    try {
      const result = write()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.action = null
    }
  }

  get(uid: string): BotItemRecord | null {
    const row = this.db.prepare('SELECT * FROM items WHERE uid = ?').get(uid)
    return row ? itemRecordOf(row) : null
  }

  byNumber(number: number): BotItemRecord | null {
    const row = this.db.prepare('SELECT * FROM items WHERE number = ?').get(number)
    return row ? itemRecordOf(row) : null
  }

  links(uid: string): BotItemLinkRecord[] {
    return this.db
      .prepare('SELECT * FROM item_links WHERE item_uid = ? ORDER BY added_event, ref')
      .all(uid)
      .flatMap((row) => linkRecordOf(row) ?? [])
  }

  events(uid: string, afterId: number, limit: number): BotItemEventRecord[] {
    return this.db
      .prepare('SELECT * FROM item_events WHERE item_uid = ? AND id > ? ORDER BY id LIMIT ?')
      .all(uid, afterId, limit)
      .map(eventRecordOf)
  }

  /** The newest `limit` events before `beforeId` (0: the newest of all), oldest first. */
  eventsBefore(uid: string, beforeId: number, limit: number): BotItemEventRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM item_events WHERE item_uid = ? AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT ?'
      )
      .all(uid, beforeId, beforeId, limit)
      .map(eventRecordOf)
      .toReversed()
  }

  protected appendEvent(
    uid: string,
    kind: string,
    actor: BotItemActor,
    data: Record<string, unknown>,
    /** Owes the item's chat a mail until the host has stored it. */
    mail: boolean,
    now: number
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO item_events (item_uid, kind, actor, data, mail, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uid,
        kind,
        JSON.stringify(actor),
        JSON.stringify(data),
        mail ? 'owed' : null,
        this.action ?? 0,
        now
      )
    const id = Number(result.lastInsertRowid)
    if (this.action === null) {
      this.action = id
      this.db.prepare('UPDATE item_events SET action = ? WHERE id = ?').run(id, id)
    }
    this.db
      .prepare(
        `UPDATE items SET version = version + 1, last_event_id = ?, last_activity_at = ?,
           updated_at = ?, others_last_event_id = CASE WHEN ? THEN ? ELSE others_last_event_id END
         WHERE uid = ?`
      )
      .run(id, now, now, Number(actor.kind !== 'owner'), id, uid)
    return id
  }

  protected requireItem(uid: string): BotItemRecord {
    const item = this.get(uid)
    if (!item) {
      throw new BotItemError('not_found', 'No such item.')
    }
    return item
  }

  /** The owner bot only, on an open item: every field and status write. `reopenTo` lets the bot
   *  reopen its own closed item, unless its owner canceled it. */
  protected requireOwnerWrite(
    item: BotItemRecord,
    actor: BotItemActor,
    reopenTo?: BotItemStatus
  ): void {
    if (actor.kind === 'bot' && actor.botId !== item.ownerBotId) {
      throw new BotItemError(
        'not_owner',
        `Item ${item.number} belongs to another bot. Read it, or ask its bot.`
      )
    }
    if (isOpenBotItemStatus(item.status)) {
      return
    }
    const closed = item.status === 'done' ? 'done' : 'canceled'
    if (reopenTo !== 'planned' && reopenTo !== 'working') {
      throw new BotItemError(
        'item_closed',
        `Item ${item.number} is ${closed}; reopen it with \`--status planned\` or \`--status in-progress\`, or comment on it.`
      )
    }
    if (actor.kind === 'bot' && item.status === 'canceled' && this.canceledByOwner(item.uid)) {
      throw new BotItemError(
        'item_closed',
        `Your owner canceled item ${item.number}, so ask them on the item (\`orca bot item comment ${item.number} --text "..."\`) before reopening it.`
      )
    }
  }

  private canceledByOwner(uid: string): boolean {
    const row = this.db
      .prepare(
        `SELECT * FROM item_events WHERE item_uid = ? AND kind = 'status' ORDER BY id DESC LIMIT 1`
      )
      .get(uid)
    return row !== undefined && eventRecordOf(row).actor.kind === 'owner'
  }

  /** Status, keeping the Needs you question only while it is Needs you and the close note only while
   *  it is closed. A new question or a close brings a snoozed item back now. */
  protected writeStatus(
    uid: string,
    status: BotItemStatus,
    question: number | null,
    actor: BotItemActor,
    now: number,
    closeNote: string | null = null
  ): void {
    const closed = !isOpenBotItemStatus(status)
    if (closed || status === 'needs_you') {
      this.endSnooze(uid, actor, now)
    }
    this.db
      .prepare(
        'UPDATE items SET status = ?, question_event = ?, close_note = ?, closed_at = ? WHERE uid = ?'
      )
      .run(
        status,
        status === 'needs_you' ? question : null,
        closed ? closeNote : null,
        closed ? now : null,
        uid
      )
  }

  /** The owner's snooze, or null to bring the item back. */
  protected writeSnooze(uid: string, until: number | null): void {
    this.db.prepare('UPDATE items SET snoozed_until = ? WHERE uid = ?').run(until, uid)
  }

  /** Brings the item back from a snooze; one still running says in Activity that it ended early. */
  protected endSnooze(uid: string, actor: BotItemActor, now: number): void {
    const row = this.db.prepare('SELECT snoozed_until FROM items WHERE uid = ?').get(uid)
    const until = typeof row?.snoozed_until === 'number' ? row.snoozed_until : null
    if (until === null) {
      return
    }
    this.writeSnooze(uid, null)
    if (until > now) {
      this.appendEvent(uid, 'unsnoozed', actor, { early: true }, false, now)
    }
  }

  /** Adds the links not there yet, each once; up to 50 per item. */
  protected insertLinks(uid: string, links: readonly BotItemLinkInput[], eventId: number): void {
    const held = new Set(this.links(uid).map(linkWords))
    for (const link of links) {
      if (held.has(linkWords(link))) {
        continue
      }
      if (held.size >= BOT_ITEM_LIMITS.links) {
        throw new BotItemError(
          'invalid_argument',
          `An item takes up to ${BOT_ITEM_LIMITS.links} links.`
        )
      }
      held.add(linkWords(link))
      this.db
        .prepare(
          `INSERT INTO item_links (item_uid, kind, ref, added_event) VALUES (?, ?, ?, ?)
           ON CONFLICT (item_uid, kind, ref) DO NOTHING`
        )
        .run(uid, link.kind, link.ref, eventId)
    }
  }
}
