import { afterEach, expect, it } from 'vitest'
import { botItemQuestionView } from '../../shared/bots/bot-item-ask'
import {
  botItemPendingCommentText,
  createBotItemPendingCommentsHook
} from '../../shared/bots/bot-item-pending-comments'
import { botItemWaitingLine } from '../../shared/bots/bot-item-question-answers'
import { botItemRefusedReplyText } from '../../shared/bots/bot-item-refused-reply'
import {
  BOT_ITEM_EVENT_KINDS,
  botItemEventId,
  parseBotItemEventId,
  type BotItemEvent
} from '../../shared/bots/bot-items'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const NOW = 1_800_000_000_000
const AGENT: BotItemBotActor = { kind: 'bot', botId: 'agent', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }

// The shared store, called outside React: one render's reads, as each app's hook gets them.
const pendingCommentsOutsideReact = createBotItemPendingCommentsHook({
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read()
})

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

/** An item whose agent asked A, then replaced it with B before the owner's reply for A landed. */
function replacedAsk(key: string) {
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
  const ask = (prompt: string): string => {
    const asked = { questions: [{ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }] }
    store.set(uid, { status: 'needs_you', ask: asked }, AGENT, NOW)
    return botItemEventId(store.get(uid)!.questionEvent!)
  }
  const a = ask('Use these hostnames?')
  const b = ask('Merge it?')
  const returned: string[] = []
  let refreshes = 0
  const pending = pendingCommentsOutsideReact(key, [], {
    post: async (entry) =>
      store.ownerComment(
        uid,
        botItemPendingCommentText(entry),
        OWNER,
        [],
        NOW,
        entry.requestId ?? undefined,
        entry.questionId === null ? undefined : (parseBotItemEventId(entry.questionId) ?? undefined)
      ),
    failed: () => {},
    returnText: (text, entry) => returned.push(botItemRefusedReplyText(entry.intent, text, '')),
    refresh: () => {
      refreshes += 1
    },
    requestIds: true,
    questionIds: true,
    plain: true
  })
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
  const answered = () =>
    store
      .events(uid, 0, 200)
      .filter((event) => event.actor.kind === 'owner' && event.kind === 'commented')
      .map((event) => event.data.answers)
  // The item as the host's read gives it, with the events a client has loaded up to `through`.
  const view = (through: string) => {
    const row = store.get(uid)!
    const rows = store.viewRows([uid], true)
    const question = rows.questions[uid]
    const waitingAsk = rows.waitingAsks[uid]
    const item = {
      status: row.status,
      question: question ? botItemQuestionView(botItemEventId(question.id), question.data) : null,
      ...(waitingAsk ? { waitingAsk } : {})
    }
    const events = store
      .events(uid, 0, 200)
      .filter((event) => event.id <= parseBotItemEventId(through)!)
      .map(({ id, kind, actor, data, createdAt }): BotItemEvent => ({
        id: botItemEventId(id),
        kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
        actor,
        data,
        at: createdAt
      }))
    return { item, events }
  }
  return {
    pending,
    a,
    b,
    ask,
    returned,
    refreshes: () => refreshes,
    settled,
    answered,
    view
  }
}

it('never records a reply for A on B: resent before the re-read settles', async () => {
  const item = replacedAsk('before-refresh')
  // An entry from before `intent`: its words still come back.
  item.pending.send('Yes', [], null, item.a)
  item.pending.send('Yes', [], null, item.a)
  await item.settled()
  expect(item.returned).toEqual(['Yes', 'Yes'])
  expect(item.answered()).toEqual([])
})

it('never records a reply for A on B: the client keeps naming A after the re-read', async () => {
  const item = replacedAsk('lasting')
  item.pending.send('Yes', [], null, item.a)
  await item.settled()
  expect(item.refreshes()).toBe(1)
  item.pending.send('Yes', [], null, item.a)
  await item.settled()
  expect(item.answered()).toEqual([])
})

it('never records a reply for A on B or a newer C', async () => {
  const item = replacedAsk('newer')
  item.pending.send('Yes', [], null, item.a)
  await item.settled()
  item.ask('Deploy now?')
  item.pending.send('Yes', [], null, item.a)
  await item.settled()
  expect(item.answered()).toEqual([])
})

it('retargets the comment box to the ask the host waits on, and a reply bound to it lands there', async () => {
  const item = replacedAsk('retarget')
  // The loaded events end at A, while the host's read names B.
  const { item: shown, events } = item.view(item.a)
  const target = botItemWaitingLine(shown, events)
  expect(target?.eventId).toBe(item.b)
  expect(target?.line).toBe('Merge it?')
  item.pending.send('No', [], null, target!.eventId)
  await item.settled()
  expect(item.answered()).toEqual([item.b])
})
