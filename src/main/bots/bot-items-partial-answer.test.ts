import { afterEach, describe, expect, it } from 'vitest'
import { botItemQuestionPairing } from '../../shared/bots/bot-item-question-answers'
import SyncDatabase from '../sqlite/sync-database'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { botItemChangeMail } from './bot-items-mail-text'
import { eventViewOf } from './bot-items-rows'
import { migrateBotItems } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const TIER = 'Which tier?'
const MERGE = 'Merge it?'
const options = [{ label: 'Yes' }, { label: 'No' }]

/** A host before this change: an owner's first answer moved the item to In progress. */
class OlderHost extends BotItemsStore {
  moveOnAnswer(uid: string): void {
    const now = Date.now()
    this.writeStatus(uid, 'working', null, OWNER, now)
    const moved = { from: 'needs_you', to: 'working', cause: 'answer' }
    this.appendEvent(uid, 'status', OWNER, moved, true, now)
  }
}

describe('an ask of several questions', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function asking(questions = [HOSTS, GO]): { store: OlderHost; uid: string; question: number } {
    const db = new SyncDatabase(':memory:')
    migrateBotItems(db)
    const store = new OlderHost(db, false)
    stores.push(store)
    const { uid } = store.add(
      {
        ownerBotId: BOT.botId,
        chatId: BOT.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      BOT
    )
    ask(store, uid, questions)
    return { store, uid, question: store.get(uid)!.questionEvent! }
  }

  function ask(store: BotItemsStore, uid: string, questions: string[]): number {
    const asked = { questions: questions.map((prompt) => ({ prompt, options })) }
    store.set(uid, { status: 'needs_you', ask: asked }, BOT)
    return store.get(uid)!.questionEvent!
  }

  function lastComment(store: BotItemsStore, uid: string): Record<string, unknown> {
    return store.events(uid, 0, 100).findLast((event) => event.kind === 'commented')!.data
  }

  function lastMailBody(store: BotItemsStore): string {
    const mail = store.owedMail(0).mails.at(-1)!
    return botItemChangeMail(mail.changes)!.body
  }

  it('stays Needs you until its last open question is answered', () => {
    const { store, uid, question } = asking()
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: question })
    // The answer still reaches the bot at once, naming what is still open.
    const partial = lastMailBody(store)
    expect(partial).toContain(GO)

    store.ownerComment(uid, `${GO} → No`, OWNER)
    expect(store.get(uid)?.status).toBe('working')
  })

  it("keeps Needs you when the item's own agent starts a worker while a question is open", () => {
    const { store, uid, question } = asking()
    store.linkStartedWorker(uid, 'ctx_1', { botId: BOT.botId, chatId: BOT.chatId })
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: question })
  })

  it('keeps waiting on an open question after the agent asks again, with or without an ask', () => {
    const { store, uid } = asking()
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    const merge = 'Merge it?'
    store.set(
      uid,
      {
        status: 'needs_you',
        ask: { questions: [{ prompt: merge, options: [{ label: 'Merge' }] }] }
      },
      BOT
    )
    store.ownerComment(uid, 'Merge', OWNER)
    expect(store.get(uid)?.status).toBe('needs_you')
    store.set(uid, { status: 'needs_you', comment: 'Only one question is left.' }, BOT)
    // Typed with no question named: it answers the oldest open line, the last one left.
    store.ownerComment(uid, 'No', OWNER)
    expect(store.get(uid)?.status).toBe('working')
  })

  it('stays Needs you when a comment names a question already answered', () => {
    const { store, uid } = asking()
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    store.ownerComment(uid, `${HOSTS} → Actually, use the internal ones`, OWNER)
    expect(store.get(uid)?.status).toBe('needs_you')
  })

  it('answers open questions on an item asking again with nothing to say', () => {
    const { store, uid, question } = asking([HOSTS, GO, TIER])
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    store.moveOnAnswer(uid)
    store.set(uid, { status: 'needs_you' }, BOT)
    expect(store.get(uid)).toMatchObject({ status: 'needs_you', questionEvent: null })
    store.ownerComment(uid, `${GO} → No`, OWNER, [], Date.now(), undefined, question)
    expect(store.get(uid)?.status).toBe('needs_you')
    store.ownerComment(uid, `${TIER} → Yes`, OWNER)
    expect(store.get(uid)?.status).toBe('working')
  })

  it("a comment sent as its own still answers the question it names, under that question's ask", () => {
    const { store, uid } = asking([HOSTS])
    const merge = ask(store, uid, [MERGE])
    // An Alt-clicked quick reply of the newer ask, sent with the box's reply target closed.
    store.ownerComment(uid, `${MERGE} → Yes`, OWNER, [], Date.now(), undefined, undefined, true)
    expect(lastComment(store, uid).answers).toBe(`e${merge}`)
    expect(store.get(uid)?.status).toBe('needs_you')
    store.ownerComment(uid, 'Yes', OWNER)
    expect(store.get(uid)?.status).toBe('working')
  })

  it('a question answered by a comment of its own keeps that answer once the item moved on', () => {
    const { store, uid, question } = asking([HOSTS])
    store.ownerComment(uid, 'Looks good', OWNER)
    expect(store.get(uid)?.status).toBe('working')
    ask(store, uid, [HOSTS])
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    const events = store.events(uid, 0, 100).map(eventViewOf)
    const first = botItemQuestionPairing({ status: 'working' }, events).questions.get(
      `e${question}`
    )
    expect(first?.answers[0]?.data.text).toBe('Looks good')
  })

  it("names the oldest open ask for the item's own view", () => {
    const { store, uid, question } = asking()
    store.ownerComment(uid, `${HOSTS} → Yes`, OWNER)
    ask(store, uid, [MERGE])
    store.set(uid, { status: 'needs_you', comment: 'Only one question is left.' }, BOT)
    expect(store.viewRows([uid], true).oldestOpenAsks[uid]).toBe(`e${question}`)
  })
})
