// A bot commenting, closing and linking its own items (comments go on closed items too, and from the
// bot that made one with `--for`; the rest only on open ones), any agent linking its own work to any
// open item, and Orca linking a worker started for an item.
import type { BotItemActor, BotItemCommentImage } from '../../shared/bots/bot-items'
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
      const data = { from: item.status, to, ...(note ? { note } : {}) }
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
      const data = { links: fresh.map(linkWords) }
      const eventId = this.appendEvent(uid, 'linked', actor, data, mailsItemChat(item, actor), now)
      this.insertLinks(uid, fresh, eventId)
      return { uid, eventId }
    })
  }

  /** A worker started for an item (`worker-start --item`): linked once, and when the item's own agent
   *  started it, Planned or Needs you moves to In progress; anyone else's worker never moves it. A
   *  closed item keeps its status. `starter`: the starting agent and chat, whose write it is, as
   *  `item link` would be; Orca's own catch-up when that chat is unknown. */
  linkStartedWorker(
    uid: string,
    dispatchId: string,
    starter: { botId: string | null; chatId: string | null },
    now = Date.now()
  ): number | null {
    return this.transaction(() => {
      const item = this.get(uid)
      if (!item || this.links(uid).some((l) => l.kind === 'dispatch' && l.ref === dispatchId)) {
        return null
      }
      const { botId, chatId } = starter
      const actor: BotItemActor =
        botId && chatId ? { kind: 'bot', botId, chatId } : { kind: 'orca', why: 'worker-start' }
      const mail = mailsItemChat(item, actor)
      const links = { links: [`dispatch:${dispatchId}`] }
      let eventId = this.appendEvent(uid, 'linked', actor, links, mail, now)
      this.insertLinks(uid, [{ kind: 'dispatch', ref: dispatchId }], eventId)
      if (botId === item.ownerBotId && (item.status === 'planned' || item.status === 'needs_you')) {
        this.writeStatus(uid, 'working', null, actor, now)
        const moved = { from: item.status, to: 'working' }
        eventId = this.appendEvent(uid, 'status', actor, moved, mail, now)
      }
      return eventId
    })
  }
}
