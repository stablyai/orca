import { afterEach, expect, it } from 'vitest'
import {
  BOT_ITEM_EVENT_KINDS,
  botItemEventId,
  type BotItemEvent
} from '../../shared/bots/bot-items'
import {
  botItemQuestionPairing,
  botItemWaitingLine
} from '../../shared/bots/bot-item-question-answers'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const NOW = 1_800_000_000_000
const AGENT: BotItemBotActor = { kind: 'bot', botId: 'agent', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const MERGE = 'Merge it?'

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function item() {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  const { uid } = store.add(
    {
      ownerBotId: AGENT.botId,
      chatId: AGENT.chatId,
      source: { kind: 'home', title: null },
      title: 'Ship it',
      status: 'working',
      links: []
    },
    AGENT,
    NOW
  )
  const ask = (questions: string[]): number => {
    const options = [{ label: 'Yes' }, { label: 'No' }]
    const asked = { questions: questions.map((prompt) => ({ prompt, options })) }
    store.set(uid, { status: 'needs_you', ask: asked }, AGENT, NOW)
    return store.get(uid)!.questionEvent!
  }
  const comment = (text: string, questionEventId?: number) =>
    store.ownerComment(uid, text, OWNER, [], NOW, undefined, questionEventId)
  // What the item's view reads: the line its comment box replies to, and each ask's answers.
  const view = () => {
    const row = store.get(uid)!
    const shown = {
      status: row.status,
      question:
        row.questionEvent === null ? null : { eventId: botItemEventId(row.questionEvent), text: '' }
    }
    const events = store
      .events(uid, 0, 200)
      .map(({ id, kind, actor, data, createdAt }): BotItemEvent => ({
        id: botItemEventId(id),
        kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
        actor,
        data,
        at: createdAt
      }))
    return {
      replyingTo: botItemWaitingLine(shown, events),
      asks: botItemQuestionPairing(shown, events).questions
    }
  }
  return { store, uid, ask, comment, view }
}

it('offers no reply target for a Needs you comment that asks nothing after the questions were answered', () => {
  const { store, uid, ask, comment, view } = item()
  const asked = ask([HOSTS, GO])
  // The held answers post together.
  comment(`${HOSTS} → Yes\n${GO} → No`, asked)
  expect(store.get(uid)?.status).toBe('working')
  store.set(
    uid,
    { status: 'needs_you', comment: 'Got it. Only the hostname question is left.' },
    AGENT,
    NOW
  )
  expect(view().replyingTo).toBeNull()
})

it('keeps an earlier set of questions answerable after a second set is asked', () => {
  const { ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  const second = ask([MERGE])
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(first), line: HOSTS })

  // The first set's held answers post together, naming their ask while the second is the item's
  // question; the second set is next.
  comment(`${HOSTS} → Yes\n${GO} → No`, first)
  expect(view().asks.get(botItemEventId(first))?.answers.every(Boolean)).toBe(true)
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(second), line: MERGE })

  // A comment box reply to it names no question and still answers it.
  comment('Yes')
  expect(view().asks.get(botItemEventId(second))?.answers.every(Boolean)).toBe(true)
  expect(view().replyingTo).toBeNull()
})

it('shows an open question left by an earlier set after a Needs you comment that asks nothing', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  // One question answered on its own (an older build, or sent sooner): the item moved on with it.
  comment(`${HOSTS} → Yes`, first)
  const second = ask([MERGE])
  comment('Yes', second)
  store.set(uid, { status: 'needs_you', comment: 'Only one question is left.' }, AGENT, NOW)
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(first), line: GO })
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(first))
})
