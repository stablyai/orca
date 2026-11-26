// A bot commenting, closing and linking its own items (comments go on closed items too, and from the
// bot that made one with `--for`; the rest only on open ones), any agent linking its own work to any
// open item, and Orca linking a worker started for an item.
import {
  isOpenBotItemStatus,
  type BotItemActor,
  type BotItemCommentImage
} from '../../shared/bots/bot-items'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { BotItemError } from './bot-item-error'
import { BotItemsEdits } from './bot-items-edits'
import { assertBotItemAttach } from './bot-items-tables'
import {
  assertBotItemText,
  linkWords,
  mailsItemChat,
  uniqueBotItemLinks,
  type BotItemBotActor,
  type BotItemLinkInput,
  type BotItemWriteOutcome
} from './bot-items-input'
import { eventRecordOf } from './bot-items-rows'
import {
  botItemAskWhileOf,
  botItemAskWithdrawnNote,
  type BotItemAskWhile,
  type BotItemAskWithdrawn
} from '../../shared/bots/bot-item-ask-while'
import type { BotItemRecord } from './bot-items-schema'

/** Orca's own wait: every worker on the item stopped on its agent's usage limit. */
export const BOT_ITEM_USAGE_LIMIT_WAIT = 'usage-limit'

/** Orca's own move: an ask whose `--while` settled is withdrawn. */
export const BOT_ITEM_ASK_WITHDRAWN = 'ask-withdrawn'

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export class BotItemsWrites extends BotItemsEdits {
  /** `images` were admitted and claimed on the host first; attachments alone make a comment. */
  comment(
    uid: string,
    commentText: string,
    actor: BotItemBotActor,
    images: readonly BotItemCommentImage[] = [],
    now = Date.now()
  ): BotItemWriteOutcome {
    assertBotItemText('text', commentText)
    if (!commentText.trim() && images.length === 0) {
      throw new BotItemError('invalid_argument', 'A comment needs its text.')
    }
    return this.transaction(() => {
      const item = this.requireItem(uid)
      const maker = actor.botId !== item.ownerBotId && actor.botId === item.madeBy?.botId
      // The bot that made it with `--for` comments too, through its caller's bot request, which is
      // the comment's mail.
      if (actor.botId !== item.ownerBotId && !maker) {
        throw new BotItemError(
          'not_owner',
          `Item ${item.number} belongs to another bot. Read it, or ask its bot.`
        )
      }
      const mail = !maker && mailsItemChat(item, actor)
      const data = { text: commentText, ...(images.length > 0 ? { images } : {}) }
      const eventId = this.appendEvent(uid, 'commented', actor, data, mail, now)
      return { uid, eventId }
    })
  }

  /** Done with an optional note, or canceled with a reason. */
  close(
    uid: string,
    to: 'done' | 'canceled',
    note: string | undefined,
    actor: BotItemBotActor,
    /** Whom the closing chat acts for, kept on the close. */
    actsFor?: readonly BotRequestAsker[],
    now = Date.now()
  ): BotItemWriteOutcome {
    assertBotItemText('note', note)
    if (to === 'canceled' && !note?.trim()) {
      throw new BotItemError('invalid_argument', 'Canceling needs a reason: --reason "..."')
    }
    return this.transaction(() => {
      const item = this.requireItem(uid)
      this.requireOwnerWrite(item, actor)
      this.writeStatus(uid, to, null, actor, now, note ?? null)
      const data = {
        from: item.status,
        to,
        ...(note ? { note } : {}),
        ...(actsFor ? { actsFor } : {})
      }
      const mail = mailsItemChat(item, actor)
      return { uid, eventId: this.appendEvent(uid, 'status', actor, data, mail, now) }
    })
  }

  /** `startedBy`: the agent whose chat started each linked Dispatch, as orchestration records it. */
  link(
    uid: string,
    links: readonly BotItemLinkInput[],
    actor: BotItemBotActor,
    startedBy: Readonly<Record<string, string | null>> = {},
    now = Date.now()
  ): BotItemWriteOutcome {
    return this.transaction(() => {
      const item = this.requireItem(uid)
      assertBotItemAttach(item, actor, links, (dispatchId) => startedBy[dispatchId] ?? null)
      const existing = this.links(uid)
      const fresh = uniqueBotItemLinks(links).filter(
        (link) => !existing.some((entry) => entry.kind === link.kind && entry.ref === link.ref)
      )
      if (fresh.length === 0) {
        return { uid, eventId: null, unchanged: true }
      }
      const mail = mailsItemChat(item, actor)
      const data = { links: fresh.map(linkWords) }
      let eventId = this.appendEvent(uid, 'linked', actor, data, mail, now)
      this.insertLinks(uid, fresh, eventId)
      // A worker its own bot links picks a Waiting item back up.
      if (
        item.status === 'waiting' &&
        actor.botId === item.ownerBotId &&
        fresh.some((link) => link.kind === 'dispatch')
      ) {
        eventId = this.moveToWorking(item, actor, mail, now)
      }
      return { uid, eventId }
    })
  }

  /** A worker started for an item (`worker-start --item`): linked once, and when the item's own agent
   *  started it, Planned, Waiting or Needs you with no open question moves to In progress; anyone else's never moves it. A
   *  closed item takes no link (a retry keeps its first start's item). `starter`: the starting agent and chat, whose write it is, as
   *  `item link` would be; Orca's own catch-up when that chat is unknown. */
  linkStartedWorker(
    uid: string,
    dispatchId: string,
    starter: { botId: string | null; chatId: string | null },
    now = Date.now()
  ): number | null {
    return this.transaction(() => {
      const item = this.get(uid)
      if (
        !item ||
        !isOpenBotItemStatus(item.status) ||
        this.links(uid).some((l) => l.kind === 'dispatch' && l.ref === dispatchId)
      ) {
        return null
      }
      const { botId, chatId } = starter
      const actor: BotItemActor =
        botId && chatId ? { kind: 'bot', botId, chatId } : { kind: 'orca', why: 'worker-start' }
      const mail = mailsItemChat(item, actor)
      const links = { links: [`dispatch:${dispatchId}`] }
      let eventId = this.appendEvent(uid, 'linked', actor, links, mail, now)
      this.insertLinks(uid, [{ kind: 'dispatch', ref: dispatchId }], eventId)
      // A question still open keeps the item on its owner: the answer moves it on.
      if (
        botId === item.ownerBotId &&
        (item.status === 'planned' ||
          item.status === 'waiting' ||
          (item.status === 'needs_you' && this.waitingAsk(item) === null))
      ) {
        eventId = this.moveToWorking(item, actor, mail, now)
      }
      return eventId
    })
  }

  /** Orca's usage-limit wait: `text` (when it resets) moves an In progress item to Waiting; null moves
   *  one Orca set Waiting this way back to In progress. Anyone else's status is left alone. */
  usageLimitWait(uid: string, text: string | null, now = Date.now()): number | null {
    return this.transaction(() => {
      const item = this.get(uid)
      const actor: BotItemActor = { kind: 'orca', why: BOT_ITEM_USAGE_LIMIT_WAIT }
      if (item?.status === 'working' && text !== null) {
        return this.moveToWait(item, text, actor, false, now)
      }
      if (item?.status !== 'waiting' || item.waitEvent === null) {
        return null
      }
      const row = this.db.prepare('SELECT * FROM item_events WHERE id = ?').get(item.waitEvent)
      const by = row === undefined ? null : eventRecordOf(row).actor
      if (by?.kind !== 'orca' || by.why !== BOT_ITEM_USAGE_LIMIT_WAIT) {
        return null
      }
      if (text !== null) {
        return text === this.waitText(item) ? null : this.moveToWait(item, text, actor, false, now)
      }
      return this.moveToWorking(item, actor, false, now)
    })
  }

  /** Items Orca set Waiting for a usage limit, linked to a worker or not. */
  usageLimitWaitUids(): string[] {
    return this.db
      .prepare(
        `SELECT items.uid FROM items JOIN item_events ON item_events.id = items.wait_event
         WHERE items.status = 'waiting' AND json_extract(item_events.actor, '$.kind') = 'orca'
           AND json_extract(item_events.actor, '$.why') = ?`
      )
      .all(BOT_ITEM_USAGE_LIMIT_WAIT)
      .map((row) => String(row.uid))
  }

  /** Needs you items whose question names what keeps it open (`--while`), with that question. */
  askWhileQuestions(): { uid: string; questionEvent: number; askWhile: BotItemAskWhile }[] {
    return this.db
      .prepare(
        `SELECT items.uid, items.question_event, json_extract(item_events.data, '$.while') AS while_json
           FROM items JOIN item_events ON item_events.id = items.question_event
          WHERE items.status = 'needs_you'
            AND json_extract(item_events.data, '$.while') IS NOT NULL`
      )
      .all()
      .flatMap((row) => {
        const askWhile = botItemAskWhileOf(parseJson(row.while_json))
        return askWhile && typeof row.question_event === 'number'
          ? [{ uid: String(row.uid), questionEvent: row.question_event, askWhile }]
          : []
      })
  }

  /** Orca withdraws an ask whose `--while` settled: back to In progress, its bot mailed. Only while
   *  that question is still the item's, so an answer or a new ask that came first wins. */
  withdrawAsk(
    uid: string,
    questionEvent: number,
    withdrawn: BotItemAskWithdrawn,
    now = Date.now()
  ): number | null {
    return this.transaction(() => {
      const item = this.get(uid)
      if (item?.status !== 'needs_you' || item.questionEvent !== questionEvent) {
        return null
      }
      const actor: BotItemActor = { kind: 'orca', why: BOT_ITEM_ASK_WITHDRAWN }
      // The questions a late reply may still name: the item's question and the ask it waited on.
      const asked = [...new Set([questionEvent, this.waitingAsk(item) ?? questionEvent])]
      this.writeStatus(uid, 'working', null, actor, now)
      const data = {
        from: 'needs_you',
        to: 'working',
        cause: 'withdrawn',
        withdrawn,
        asked,
        note: botItemAskWithdrawnNote(withdrawn)
      }
      return this.appendEvent(uid, 'status', actor, data, true, now)
    })
  }

  /** Orca's withdrawals whose mail is still owed, as a crash before the send left them. */
  owedWithdrawals(): number[] {
    return this.db
      .prepare(
        `SELECT id FROM item_events WHERE mail = 'owed' AND kind = 'status'
           AND json_extract(actor, '$.kind') = 'orca' AND json_extract(actor, '$.why') = ?`
      )
      .all(BOT_ITEM_ASK_WITHDRAWN)
      .map((row) => Number(row.id))
  }

  /** Of these events, the ones whose mail is still owed. */
  stillOwed(eventIds: readonly number[]): number[] {
    if (eventIds.length === 0) {
      return []
    }
    return this.db
      .prepare(
        `SELECT id FROM item_events WHERE mail = 'owed'
           AND id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(eventIds))
      .map((row) => Number(row.id))
  }

  private moveToWorking(item: BotItemRecord, actor: BotItemActor, mail: boolean, now: number) {
    this.writeStatus(item.uid, 'working', null, actor, now)
    const moved = { from: item.status, to: 'working' }
    return this.appendEvent(item.uid, 'status', actor, moved, mail, now)
  }

  /** Orca's own line on an item, such as why a worker started for it had to start in a terminal.
   *  It mails no chat: the starter already read the same reason in its receipt. */
  orcaComment(uid: string, text: string, why: string, now = Date.now()): BotItemWriteOutcome {
    assertBotItemText('text', text)
    return this.transaction(() => {
      this.requireItem(uid)
      const eventId = this.appendEvent(
        uid,
        'commented',
        { kind: 'orca', why },
        { text },
        false,
        now
      )
      return { uid, eventId }
    })
  }
}
