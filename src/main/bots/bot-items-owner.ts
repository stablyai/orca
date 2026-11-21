// The owner's writes from the panel (desktop or phone): comments, which move a Needs you item to In
// progress (one written while the bot asks is the answer), and any status on any number of items, each
// owing the item's chat a mail; and snoozes, which mail nobody. A comment or status move brings a snoozed item back.
import {
  botItemEventId,
  isOpenBotItemStatus,
  type BotItemCommentImage,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import { BOT_ITEM_SNOOZE_MAX_MS } from '../../shared/bots/bot-item-snooze'
import { BotItemError } from './bot-item-error'
import { BotItemsWrites } from './bot-items-writes'
import {
  assertBotItemText,
  type BotItemOwnerActor,
  type BotItemWriteOutcome
} from './bot-items-input'
import { eventRecordOf } from './bot-items-rows'
import type { BotItemMail, BotItemRecord } from './bot-items-schema'

const OWED_MAIL_PAGE = 50

export type BotItemOwnerStatusInput = {
  uids: readonly string[]
  to: BotItemStatus
  reason?: string
  comment?: string
}

export type BotItemOwnerOutcome = { uid: string; eventId: number | null; woke: boolean }

export type BotItemOwnerSnoozeInput = {
  /** Each item with the newest event by anyone but the owner that the owner's view showed. */
  items: readonly { uid: string; othersLastEventId: number }[]
  /** Null brings the items back. */
  until: number | null
}

export class BotItemsOwner extends BotItemsWrites {
  /** `images` were admitted and claimed on the host first; attachments alone make a comment.
   *  `requestId`: the sender's id for this comment; sent again (a retry after a lost answer), it
   *  returns the comment it already made instead of a second one. */
  ownerComment(
    uid: string,
    commentText: string,
    actor: BotItemOwnerActor,
    images: readonly BotItemCommentImage[] = [],
    now = Date.now(),
    requestId?: string,
    /** The question event a quick reply answers: refused once the agent is asking another. */
    questionEventId?: number,
    /** A comment of its own: it answers no question, so a Needs you item keeps waiting on it. */
    plain = false
  ): BotItemWriteOutcome {
    assertBotItemText('text', commentText)
    if (!commentText.trim() && images.length === 0) {
      throw new BotItemError('invalid_argument', 'A comment needs its text.')
    }
    return this.transaction(() => {
      const item = this.requireItem(uid)
      const made = requestId === undefined ? null : this.ownerCommentByRequest(uid, requestId)
      if (made !== null) {
        return { uid, eventId: made }
      }
      if (
        questionEventId !== undefined &&
        item.status === 'needs_you' &&
        item.questionEvent !== null &&
        item.questionEvent !== questionEventId &&
        this.askedByBot(item.questionEvent)
      ) {
        throw new BotItemError(
          'item_changed',
          `Item ${item.number} has a new question. Read it, then reply.`
        )
      }
      // While the bot asks, a comment not sent as plain is the answer: it names the question, and the
      // move it makes says so. A plain one leaves the item waiting on its question.
      const asked =
        item.status === 'needs_you' &&
        item.questionEvent !== null &&
        this.askedByBot(item.questionEvent)
          ? item.questionEvent
          : null
      const answers = asked !== null && !plain ? botItemEventId(asked) : undefined
      const eventId = this.writeOwnerComment(
        item,
        commentText,
        actor,
        now,
        images,
        requestId,
        answers,
        plain
      )
      this.endSnooze(uid, actor, now)
      // A reply hands the item back to the bot.
      if (item.status === 'needs_you' && !(asked !== null && plain)) {
        this.writeStatus(uid, 'working', null, actor, now)
        const moved = { from: item.status, to: 'working', ...(answers ? { cause: 'answer' } : {}) }
        this.appendEvent(uid, 'status', actor, moved, true, now)
      }
      return { uid, eventId }
    })
  }

  /** The owner's own Needs you note is no question to answer. */
  private askedByBot(eventId: number): boolean {
    const row = this.db.prepare('SELECT * FROM item_events WHERE id = ?').get(eventId)
    return row !== undefined && eventRecordOf(row).actor.kind === 'bot'
  }

  private ownerCommentByRequest(uid: string, requestId: string): number | null {
    const row: unknown = this.db
      .prepare(
        `SELECT id FROM item_events WHERE item_uid = ? AND kind = 'commented'
           AND json_extract(data, '$.requestId') = ? LIMIT 1`
      )
      .get(uid, requestId)
    return typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'number'
      ? row.id
      : null
  }

  private writeOwnerComment(
    item: BotItemRecord,
    commentText: string,
    actor: BotItemOwnerActor,
    now: number,
    images: readonly BotItemCommentImage[] = [],
    requestId?: string,
    answers?: string,
    plain = false
  ): number {
    const data = {
      text: commentText,
      ...(images.length > 0 ? { images } : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...(answers === undefined ? {} : { answers }),
      ...(plain ? { plain: true } : {})
    }
    return this.appendEvent(item.uid, 'commented', actor, data, true, now)
  }

  /** One status for every item named, each its own event, in one transaction. */
  ownerStatus(
    input: BotItemOwnerStatusInput,
    actor: BotItemOwnerActor,
    now = Date.now()
  ): { items: BotItemOwnerOutcome[] } {
    assertBotItemText('note', input.reason)
    assertBotItemText('text', input.comment)
    if (input.to === 'canceled' && !input.reason?.trim()) {
      throw new BotItemError('invalid_argument', 'Canceling needs a reason.')
    }
    return this.transaction(() => ({
      items: input.uids.map((uid) => this.writeOwnerStatus(uid, input, actor, now))
    }))
  }

  private writeOwnerStatus(
    uid: string,
    input: BotItemOwnerStatusInput,
    actor: BotItemOwnerActor,
    now: number
  ): BotItemOwnerOutcome {
    const item = this.requireItem(uid)
    const comment = input.comment?.trim()
      ? this.writeOwnerComment(item, input.comment, actor, now)
      : null
    if (item.status === input.to) {
      if (comment !== null) {
        this.endSnooze(uid, actor, now)
      }
      return { uid, eventId: comment, woke: comment !== null }
    }
    this.endSnooze(uid, actor, now)
    const closing = input.to === 'done' || input.to === 'canceled'
    const note = closing ? (input.reason?.trim() ? input.reason : null) : null
    this.writeStatus(uid, input.to, input.to === 'needs_you' ? comment : null, actor, now, note)
    const data = { from: item.status, to: input.to, ...(note ? { note } : {}) }
    return { uid, eventId: this.appendEvent(uid, 'status', actor, data, true, now), woke: true }
  }

  /** Snoozes the items until a time, or brings them back; the bot reads it, no mail. A snooze is refused
   *  when the bot moved an item after the owner's view read it, so a new question is never hidden unseen. */
  ownerSnooze(
    input: BotItemOwnerSnoozeInput,
    actor: BotItemOwnerActor,
    now = Date.now()
  ): { items: { uid: string; eventId: number | null }[] } {
    const { until } = input
    if (until !== null && (until <= now || until > now + BOT_ITEM_SNOOZE_MAX_MS)) {
      throw new BotItemError('invalid_argument', 'Snooze until a time within the next year.')
    }
    return this.transaction(() => ({
      items: input.items.map(({ uid, othersLastEventId }) => {
        const item = this.requireItem(uid)
        if (!isOpenBotItemStatus(item.status)) {
          throw new BotItemError('item_closed', `Item ${item.number} is closed.`)
        }
        if (until !== null && this.movedBySomeoneElse(uid, othersLastEventId)) {
          throw new BotItemError(
            'item_changed',
            `Item ${item.number} changed since you looked. Check it, then snooze it again.`
          )
        }
        if (until === null && (item.snoozedUntil === null || item.snoozedUntil <= now)) {
          return { uid, eventId: null }
        }
        this.writeSnooze(uid, until)
        const eventId =
          until === null
            ? this.appendEvent(uid, 'unsnoozed', actor, {}, false, now)
            : this.appendEvent(uid, 'snoozed', actor, { until }, false, now)
        return { uid, eventId }
      })
    }))
  }

  /** A status change by anyone but the owner after the event the owner's view showed: a new question,
   *  a close or a move. Comments, edits and links neither wake a snooze nor refuse one. */
  private movedBySomeoneElse(uid: string, afterEventId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM item_events WHERE item_uid = ? AND id > ? AND kind = 'status'
           AND json_extract(actor, '$.kind') != 'owner' LIMIT 1`
      )
      .get(uid, afterEventId)
    return row !== undefined
  }

  /** The newest event on this bot's items: what the owner has seen once its Items tab opens. */
  latestEventId(botId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(last_event_id), 0) AS id FROM items WHERE owner_bot_id = ?')
      .get(botId)
    return Number(row?.id ?? 0)
  }

  /** Mail the host still owes, a page of writes after `afterAction`, oldest first: one per write
   *  and chat. `through` is the page's last write, or null when none are left. */
  owedMail(afterAction: number): { mails: BotItemMail[]; through: number | null } {
    const rows = this.db
      .prepare(
        `SELECT * FROM item_events WHERE mail = 'owed' AND action IN (
           SELECT DISTINCT action FROM item_events WHERE mail = 'owed' AND action > ?
            ORDER BY action LIMIT ?)
          ORDER BY id`
      )
      .all(afterAction, OWED_MAIL_PAGE)
    const mails = new Map<string, BotItemMail>()
    let through: number | null = null
    for (const row of rows) {
      const event = eventRecordOf(row)
      const item = this.get(event.itemUid)
      through = Math.max(through ?? 0, Number(row.action))
      if (!item) {
        continue
      }
      const key = `${String(row.action)} ${item.ownerBotId} ${item.chatId}`
      const mail = mails.get(key)
      if (mail) {
        mail.changes.push({ event, item })
      } else {
        mails.set(key, {
          id: event.id,
          ownerBotId: item.ownerBotId,
          chatId: item.chatId,
          changes: [{ event, item }]
        })
      }
    }
    return { mails: [...mails.values()], through }
  }

  markMailSent(eventIds: readonly number[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE item_events SET mail = 'sent' WHERE mail = 'owed' AND id IN (SELECT value FROM json_each(?))"
        )
        .run(JSON.stringify(eventIds))
    })
  }
}
