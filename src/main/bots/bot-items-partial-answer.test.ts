import { afterEach, describe, expect, it } from 'vitest'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { botItemChangeMail } from './bot-items-mail-text'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'

describe('an ask of several questions', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function asking(): { store: BotItemsStore; uid: string; question: number | null } {
    const store = BotItemsStore.open(':memory:')
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
    const options = [{ label: 'Yes' }, { label: 'No' }]
    store.set(
      uid,
      {
        status: 'needs_you',
        ask: { questions: [HOSTS, GO].map((prompt) => ({ prompt, options })) }
      },
      BOT
    )
    return { store, uid, question: store.get(uid)!.questionEvent }
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
})
