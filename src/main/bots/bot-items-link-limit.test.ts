import { afterEach, describe, expect, it } from 'vitest'
import type { BotItemBotActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const OWNER: BotItemBotActor = { kind: 'bot', botId: 'owner', chatId: 'owner-chat' }
const FULL = /An item takes up to 1000 links\./

const urls = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => ({ kind: 'url', ref: `https://e.test/${from + i}` }) as const
  )

describe('an item’s link bound', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function item(): { store: BotItemsStore; uid: string } {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    const { uid } = store.add(
      {
        ownerBotId: OWNER.botId,
        chatId: OWNER.chatId,
        source: { kind: 'home', title: null },
        title: 'Busy',
        status: 'working',
        links: urls(0, 60)
      },
      OWNER
    )
    return { store, uid }
  }

  it('takes links past 50 on every path, up to 1000, and refuses the next on each', () => {
    const { store, uid } = item()
    store.link(uid, urls(60, 900), OWNER)
    expect(store.linkStartedWorker(uid, 'ctx_a', OWNER)).not.toBeNull()
    store.link(uid, urls(960, 39), OWNER)
    expect(store.links(uid)).toHaveLength(1000)

    expect(() => store.link(uid, urls(5000, 1), OWNER)).toThrow(FULL)
    expect(() => store.linkStartedWorker(uid, 'ctx_b', OWNER)).toThrow(FULL)
    // One already held adds nothing, so a full item still takes it.
    expect(store.link(uid, urls(0, 1), OWNER)).toMatchObject({ unchanged: true })
    expect(store.links(uid)).toHaveLength(1000)
  })

  it('refuses a write that would cross the bound whole, adding none of its links', () => {
    const { store, uid } = item()
    expect(() => store.link(uid, urls(60, 941), OWNER)).toThrow(FULL)
    expect(store.links(uid)).toHaveLength(60)
  })
})
