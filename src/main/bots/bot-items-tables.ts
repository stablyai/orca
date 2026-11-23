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
import {
  hasKeptWaitingAsks,
  keepAfterWrite,
  lastEventOf,
  touchedBy,
  waitingAskChange,
  waitingAskOf,
  type TouchedItem
} from './bot-item-waiting-ask-keep'
import { eventRecordOf, itemRecordOf, linkRecordOf } from './bot-items-rows'
import type { BotItemEventRecord, BotItemLinkRecord, BotItemRecord } from './bot-items-schema'

export class BotItemsTables {
  /** The current write's first event, while one runs. */
  private action: number | null = null
  /** Items the current write added events to, whose kept asks are brought up to date once it commits. */
  private touched: Map<string, TouchedItem> | null = null
  private keeps: boolean | null = null

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
    const touched = new Map<string, TouchedItem>()
    this.touched = touched
    let result: T
    try {
      result = write()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.action = null
      this.touched = null
    }
    // After the commit and on its own, so keeping an ask can never fail or slow the write it follows.
    touched.forEach((item, uid) => keepAfterWrite(this.db, uid, item))
    return result
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
    const keeps = this.keepsWaitingAsks()
    const before = keeps && !this.touched?.has(uid) ? lastEventOf(this.db, uid) : 0
    this.db
      .prepare(
        `UPDATE items SET version = version + 1, last_event_id = ?, last_activity_at = ?,
           updated_at = ?, others_last_event_id = CASE WHEN ? THEN ? ELSE others_last_event_id END
         WHERE uid = ?`
      )
      .run(id, now, now, Number(actor.kind !== 'owner'), id, uid)
    if (keeps) {
      const change = waitingAskChange(kind, actor, data)
      const item = touchedBy(this.touched?.get(uid), before, id, change)
      if (this.touched) {
        this.touched.set(uid, item)
      } else {
        keepAfterWrite(this.db, uid, item)
      }
    }
    return id
  }

  /** The item's ask waiting on the owner, which a later question can leave open: the kept one while it
   *  holds, else worked out from all its events (and kept for the next open, unless a write is running). */
  protected waitingAsk(item: Pick<BotItemRecord, 'uid'>): number | null {
    return waitingAskOf(this.db, item.uid, this.keepsWaitingAsks(), this.touched === null)
  }

  /** This file keeps each item's waiting ask, and this build may write it. */
  protected keepsWaitingAsks(): boolean {
    this.keeps ??= !this.readOnly && hasKeptWaitingAsks(this.db)
    return this.keeps
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
    assertBotItemOwnerWrite(item, actor, reopenTo)
    if (isOpenBotItemStatus(item.status)) {
      return
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
   *  it is closed; any move ends a wait, which `writeWait` names again for Waiting. A new question or a
   *  close brings a snoozed item back now. */
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
        `UPDATE items SET status = ?, question_event = ?, close_note = ?, closed_at = ?,
           wait_event = NULL WHERE uid = ?`
      )
      .run(
        status,
        status === 'needs_you' ? question : null,
        closed ? closeNote : null,
        closed ? now : null,
        uid
      )
  }

  /** A move to Waiting and its status event, whose note says what it waits on. */
  protected moveToWait(
    item: BotItemRecord,
    note: string,
    actor: BotItemActor,
    mail: boolean,
    now: number
  ): number {
    this.writeStatus(item.uid, 'waiting', null, actor, now)
    const data = { from: item.status, to: 'waiting', note }
    const eventId = this.appendEvent(item.uid, 'status', actor, data, mail, now)
    this.db.prepare('UPDATE items SET wait_event = ? WHERE uid = ?').run(eventId, item.uid)
    return eventId
  }

  /** What a Waiting item waits on, as its status event says; null for any other item. */
  protected waitText(item: BotItemRecord): string | null {
    if (item.status !== 'waiting' || item.waitEvent === null) {
      return null
    }
    const row = this.db.prepare('SELECT * FROM item_events WHERE id = ?').get(item.waitEvent)
    const note = row === undefined ? null : eventRecordOf(row).data.note
    return typeof note === 'string' ? note : null
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

/** The owner-write rules readable from the item alone: its bot's, and open unless this reopens it. */
export function assertBotItemOwnerWrite(
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
  assertBotItemOpen(item, reopenTo)
}

/** Links on an open item: any agent attaches its own work (workers it started, PRs, URLs, files) to
 *  any item here; only the item's own agent links another's workers. `startedBy` names a Dispatch's
 *  starting agent, read only for a link by someone else. */
export function assertBotItemAttach(
  item: BotItemRecord,
  actor: BotItemActor,
  links: readonly BotItemLinkInput[],
  startedBy: (dispatchId: string) => string | null
): void {
  if (actor.kind === 'bot' && actor.botId !== item.ownerBotId) {
    const other = links.find(
      (link) => link.kind === 'dispatch' && startedBy(link.ref) !== actor.botId
    )
    if (other) {
      throw new BotItemError(
        'not_owner',
        `Item ${item.number} belongs to another bot: link only workers you started, not dispatch:${other.ref}.`
      )
    }
    if (!isOpenBotItemStatus(item.status)) {
      throw new BotItemError('item_closed', `Item ${item.number} is closed. Ask its bot.`)
    }
    return
  }
  assertBotItemOpen(item)
}

function assertBotItemOpen(item: BotItemRecord, reopenTo?: BotItemStatus): void {
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
}
