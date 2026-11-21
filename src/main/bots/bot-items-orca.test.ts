import { afterEach, describe, expect, it } from 'vitest'
import { botItemEventId } from '../../shared/bots/bot-items'
import { BotItemsStore } from './bot-items-store'

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function open(): BotItemsStore {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  return store
}

const ASK = {
  context: 'Answer Keep all, Keep none, or numbers.',
  questions: [
    {
      prompt: 'Keep these lines in memory?',
      options: [{ label: 'Keep all' }, { label: 'Keep none' }]
    }
  ]
}
const made = {
  ownerBotId: 'bot-a',
  chatId: 'chat-home',
  source: { kind: 'home' as const, title: null },
  title: 'Keep 2 possible decisions of yours in memory?',
  description: '1. a\n2. b'
}

describe("Orca's own question on a bot's item", () => {
  it('is made already asking, as Orca, and wakes no chat', () => {
    const store = open()
    const { uid } = store.orcaAsk(made, ASK, 'salvage', 1)
    const item = store.get(uid)
    expect(item).toMatchObject({ status: 'needs_you', description: '1. a\n2. b' })
    const events = store.events(uid, 0, 50)
    expect(events.every(({ actor }) => actor.kind === 'orca')).toBe(true)
    expect(events.find(({ id }) => id === item?.questionEvent)?.data).toMatchObject({ ask: ASK })
    expect(store.owedMail(0).mails).toEqual([])
  })

  it("takes the owner's quick reply as the answer to it", () => {
    const store = open()
    const { uid } = store.orcaAsk(made, ASK, 'salvage', 1)
    const asked = store.get(uid)!.questionEvent!
    store.ownerComment(uid, 'Keep all', { kind: 'owner' }, [], 2, undefined, asked)
    const answer = store.events(uid, asked, 50).find(({ kind }) => kind === 'commented')
    expect(answer?.data).toMatchObject({ text: 'Keep all', answers: botItemEventId(asked) })
    expect(store.get(uid)?.status).toBe('working')
  })

  it('asks again and closes with a note, as Orca', () => {
    const store = open()
    const { uid } = store.orcaAsk(made, ASK, 'salvage', 1)
    const first = store.get(uid)!.questionEvent
    store.ownerComment(uid, 'maybe', { kind: 'owner' }, [], 2)
    store.orcaSet(uid, { status: 'needs_you', ask: ASK }, 'salvage', 3)
    expect(store.get(uid)?.questionEvent).not.toBe(first)
    store.orcaSet(uid, { status: 'done', note: 'Kept 2 in memory.' }, 'salvage', 4)
    expect(store.get(uid)).toMatchObject({ status: 'done', closeNote: 'Kept 2 in memory.' })
  })
})
