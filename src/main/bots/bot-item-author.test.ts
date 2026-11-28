// An item event is unseen for every viewer but its author: the owner and each teammate alike.
import { afterEach, expect, it } from 'vitest'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const AGENT: BotItemBotActor = { kind: 'bot', botId: 'bot-1', chatId: 'chat-1' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const ALICE: BotItemOwnerActor = {
  kind: 'owner',
  person: { accountId: 'acct-alice', name: 'Alice' }
}

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

it("marks a teammate's comment unseen for the owner, and the owner's for the teammate", () => {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  const { uid } = store.add(
    {
      ownerBotId: 'bot-1',
      chatId: 'chat-1',
      source: { kind: 'home', title: null },
      title: 'Ship it',
      status: 'working',
      links: []
    },
    AGENT
  )
  const lastFor = (viewer?: string): number =>
    store.viewRows([uid], false, viewer).othersLast[uid] ?? 0
  const made = lastFor()

  const owners = store.ownerComment(uid, 'Owner here', OWNER).eventId!
  expect(lastFor()).toBe(made)
  expect(lastFor('acct-alice')).toBe(owners)

  const alices = store.ownerComment(uid, 'Alice here', ALICE).eventId!
  expect(lastFor()).toBe(alices)
  expect(lastFor('acct-alice')).toBe(owners)
  // Another teammate sees both.
  expect(lastFor('acct-bob')).toBe(alices)
})
