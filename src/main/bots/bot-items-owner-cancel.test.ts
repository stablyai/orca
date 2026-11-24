import { afterEach, expect, it } from 'vitest'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { botItemChangeMail } from './bot-items-mail-text'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function cancel(reason?: string): string {
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
  store.ownerStatus({ uids: [uid], to: 'canceled', ...(reason ? { reason } : {}) }, OWNER)
  const item = store.get(uid)!
  expect(item.status).toBe('canceled')
  const event = store.events(uid, item.lastEventId - 1, 1)[0]!
  return botItemChangeMail([{ event, item }])!.body.split('\n')[1]!
}

it('cancels an item for the owner without a reason, and the mail line ends at the cancel', () => {
  expect(cancel()).toMatch(/: canceled it \(event [^)]+\)$/)
  expect(cancel('Not needed')).toMatch(/: canceled it: "Not needed" \(event [^)]+\)$/)
})
