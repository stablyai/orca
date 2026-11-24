import { afterEach, expect, it } from 'vitest'
import {
  botItemPendingCommentText,
  createBotItemPendingCommentsHook,
  type BotItemPendingComment
} from '../../shared/bots/bot-item-pending-comments'
import { botItemRefusedReplyText } from '../../shared/bots/bot-item-refused-reply'
import { botItemEventId, parseBotItemEventId } from '../../shared/bots/bot-items'
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

/** An item whose agent asked one question, then replaced it with another before the reply landed. */
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
  const first = ask('Use these hostnames?')
  const second = ask('Merge it?')
  const posted: BotItemPendingComment[] = []
  const returned: string[] = []
  const pending = pendingCommentsOutsideReact(key, [], {
    post: async (entry) => {
      posted.push(entry)
      return store.ownerComment(
        uid,
        botItemPendingCommentText(entry),
        OWNER,
        [],
        NOW,
        entry.requestId ?? undefined,
        entry.questionId === null ? undefined : (parseBotItemEventId(entry.questionId) ?? undefined)
      )
    },
    failed: () => {},
    returnText: (text, entry) => returned.push(botItemRefusedReplyText(entry.intent, text, '')),
    refresh: () => {},
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
  return { pending, first, second, posted, returned, settled, answered }
}

it('sends a reply unbound when the ask it names is still the refused one, and the host answers its waiting ask', async () => {
  const item = replacedAsk('unmoved')
  // An entry from before `intent`: its words still come back.
  item.pending.send('Yes', [], null, item.first)
  await item.settled()
  expect(item.returned).toEqual(['Yes'])
  expect(item.answered()).toEqual([])
  // The re-read still names the first ask: the next reply goes unbound and lands on the host's ask.
  item.pending.send('Yes', [], null, item.first)
  await item.settled()
  expect(item.posted.at(-1)?.questionId).toBeNull()
  expect(item.answered()).toEqual([item.second])
})

it('binds a reply to the ask the re-read moved to', async () => {
  const item = replacedAsk('moved')
  item.pending.send('Yes', [], null, item.first)
  await item.settled()
  item.pending.send('No', [], null, item.second)
  await item.settled()
  expect(item.posted.at(-1)?.questionId).toBe(item.second)
  expect(item.answered()).toEqual([item.second])
})
