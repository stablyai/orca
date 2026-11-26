// Making an item and changing its fields or status. A status move can carry a comment (Needs you
// must: it is the question); any other status clears that question. A closed item reopens here.
import { randomUUID } from 'node:crypto'
import { BOT_ITEM_LIMITS, isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { BotItemError } from './bot-item-error'
import {
  assertBotItemAddable,
  assertBotItemText,
  botItemCommentData,
  botItemWaitText,
  linkWords,
  uniqueBotItemLinks,
  mailsItemChat,
  type BotItemAddInput,
  type BotItemBotActor,
  type BotItemSetInput,
  type BotItemWriteOutcome
} from './bot-items-input'
import { BotItemsReads } from './bot-items-reads'
import type { BotItemRecord } from './bot-items-schema'

type TextField = 'title' | 'description' | 'doneMeans'

const WAIT_WORDS = {
  missing: '--status waiting needs --note "<what it waits on>".',
  tooLong: `Keep the wait to one line (up to ${BOT_ITEM_LIMITS.wait} characters); put details in --comment.`
}

export class BotItemsEdits extends BotItemsReads {
  add(input: BotItemAddInput, actor: BotItemBotActor, now = Date.now()): BotItemWriteOutcome {
    const links = uniqueBotItemLinks(input.links)
    assertBotItemAddable({ ...input, links })
    return this.transaction(() => this.insertItem({ ...input, links }, actor, now))
  }

  private insertItem(
    input: BotItemAddInput,
    actor: BotItemBotActor,
    now: number
  ): BotItemWriteOutcome {
    const uid = input.uid ?? randomUUID()
    const next = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM items').get()
    this.db
      .prepare(
        `INSERT INTO items (uid, number, owner_bot_id, chat_id, source, made_by, title, description,
           done_means, status, version, last_event_id, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
      )
      .run(
        uid,
        Number(next?.next ?? 1),
        input.ownerBotId,
        input.chatId,
        JSON.stringify(input.source),
        input.madeBy ? JSON.stringify(input.madeBy) : null,
        input.title,
        input.description ?? null,
        input.doneMeans ?? null,
        input.status,
        now,
        now,
        now
      )
    const eventId = this.appendEvent(
      uid,
      'made',
      actor,
      {
        title: input.title,
        status: input.status,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.doneMeans !== undefined ? { doneMeans: input.doneMeans } : {}),
        ...(input.links.length > 0 ? { links: input.links.map(linkWords) } : {}),
        // `startedInOwed`: set since only a handoff or the item's own thread gives a place; an older
        // item's may be the thread of a question it answered, whose result goes to the asking bot.
        ...(input.startedIn ? { startedIn: input.startedIn, startedInOwed: true } : {})
      },
      false,
      now
    )
    this.insertLinks(uid, input.links, eventId)
    return { uid, eventId, created: true }
  }

  set(
    uid: string,
    changes: BotItemSetInput,
    actor: BotItemBotActor,
    now = Date.now()
  ): BotItemWriteOutcome {
    assertBotItemSetInput(changes)
    return this.transaction(() => this.applySet(uid, changes, actor, now))
  }

  private applySet(
    uid: string,
    changes: BotItemSetInput,
    actor: BotItemBotActor,
    now: number
  ): BotItemWriteOutcome {
    const item = this.requireItem(uid)
    this.requireOwnerWrite(item, actor, changes.status)
    const waitNote =
      changes.status === 'waiting' ? botItemWaitText(changes.note, WAIT_WORDS) : undefined
    // The owner's open question never hides behind a quieter status.
    if (waitNote !== undefined && item.status === 'needs_you') {
      throw new BotItemError(
        'invalid_argument',
        `Item ${item.number} waits on your owner's answer. It stays Needs you; put the wait in a comment.`
      )
    }
    const mail = mailsItemChat(item, actor)
    const fields: Partial<Record<TextField, { from: string | null; to: string | null }>> = {}
    for (const field of ['title', 'description', 'doneMeans'] as const) {
      const value = changes[field]
      // An empty description or done-means clears it; a title is never empty.
      const to = value === undefined ? undefined : value === '' && field !== 'title' ? null : value
      if (to !== undefined && to !== item[field]) {
        fields[field] = { from: item[field], to }
      }
    }
    const edited = Object.keys(fields).length > 0
    const commentText = changes.comment?.trim() ? changes.comment : undefined
    const images = changes.images?.length ? { images: changes.images } : {}
    const commentData =
      commentText !== undefined || changes.ask
        ? {
            ...botItemCommentData(commentText, changes.ask),
            ...images,
            ...(changes.ask && changes.askedInConversation
              ? { askedInConversation: changes.askedInConversation }
              : {})
          }
        : undefined
    // Asking again while already Needs you is a new question, and Waiting on something new a new wait;
    // the same status with nothing new is no change.
    const status =
      changes.status !== undefined &&
      (changes.status !== item.status ||
        (changes.status === 'needs_you' && commentData !== undefined) ||
        (waitNote !== undefined && waitNote !== this.waitText(item)))
        ? changes.status
        : undefined
    if (!edited && status === undefined && commentData === undefined) {
      return { uid, eventId: null, unchanged: true }
    }
    const closing = status === 'done' || status === 'canceled'
    const closeNote = (status === 'canceled' ? changes.reason : changes.note) ?? null
    const moveNote = closing ? closeNote : edited ? null : (changes.note ?? null)
    const move = (question: number | null) => {
      if (waitNote !== undefined) {
        return this.moveToWait(item, waitNote, actor, mail, now)
      }
      this.writeStatus(uid, status!, question, actor, now, closing ? closeNote : null)
      const data = {
        from: item.status,
        to: status,
        ...(moveNote ? { note: moveNote } : {}),
        ...(closing && changes.closedFor ? { actsFor: changes.closedFor } : {})
      }
      return this.appendEvent(uid, 'status', actor, data, mail, now)
    }
    // A reopen comes first, so the edits it allows read after it.
    const reopening = status !== undefined && !isOpenBotItemStatus(item.status)
    let eventId: number | null = reopening ? move(null) : null
    if (edited) {
      this.writeFields(item, fields)
      const note =
        changes.note && status !== 'done' && waitNote === undefined ? { note: changes.note } : {}
      eventId = this.appendEvent(uid, 'edited', actor, { fields, ...note }, mail, now)
    }
    const comment =
      commentData === undefined
        ? null
        : this.appendEvent(uid, 'commented', actor, commentData, mail, now)
    eventId = comment ?? eventId
    if (status !== undefined && !reopening) {
      eventId = move(comment)
    }
    return { uid, eventId }
  }

  private writeFields(
    item: BotItemRecord,
    fields: Partial<Record<TextField, { to: string | null }>>
  ): void {
    const value = (field: TextField) => (fields[field] ? fields[field].to : item[field])
    this.db
      .prepare('UPDATE items SET title = ?, description = ?, done_means = ? WHERE uid = ?')
      .run(value('title') ?? item.title, value('description'), value('doneMeans'), item.uid)
  }
}

/** What `set` refuses from its input alone, before reading the item. */
export function assertBotItemSetInput(changes: BotItemSetInput): void {
  assertBotItemText('title', changes.title)
  assertBotItemText('description', changes.description)
  assertBotItemText('doneMeans', changes.doneMeans)
  assertBotItemText('note', changes.note)
  assertBotItemText('note', changes.reason)
  assertBotItemText('text', changes.comment)
  if (changes.status === 'canceled' && !changes.reason?.trim()) {
    throw new BotItemError('invalid_argument', 'Canceling needs a reason: --reason "..."')
  }
  if (changes.reason !== undefined && changes.status !== 'canceled') {
    throw new BotItemError('invalid_argument', '--reason goes with --status canceled.')
  }
  if (changes.status === 'waiting') {
    botItemWaitText(changes.note, WAIT_WORDS)
  }
  if (changes.ask !== undefined && changes.status !== 'needs_you') {
    throw new BotItemError('invalid_argument', '--ask goes with --status needs-you.')
  }
  if (changes.comment !== undefined && changes.status === undefined) {
    throw new BotItemError(
      'invalid_argument',
      '--comment goes with --status; otherwise use `orca bot item comment`.'
    )
  }
  if (changes.title !== undefined && !changes.title.trim()) {
    throw new BotItemError('invalid_argument', 'An item needs a title.')
  }
}
