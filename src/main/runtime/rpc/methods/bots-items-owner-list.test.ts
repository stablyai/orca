import { afterEach, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItem } from '../../../../shared/bots/bot-items'
import type { BotItemBotActor } from '../../../bots/bot-items-input'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import { BotItemsStore } from '../../../bots/bot-items-store'
import { botItemListScope, botItemsOfPeople } from '../../../bots/bot-item-access'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import type { RpcContext } from '../core'
import { BOT_ITEMS_OWNER_METHODS } from './bots-items-owner-methods'
import { ownerActor } from './bots-items-owner-person'

const AGENT: BotItemBotActor = { kind: 'bot', botId: 'bot-1', chatId: 'chat-1' }
const share = (accountId: string, name: string, email: string) =>
  ({ kind: 'account', shareId: `s-${accountId}`, accountId, name, email, addedAt: 1 }) as const
const BOT: Bot = makeTestBot({
  id: 'bot-1',
  shares: [
    share('acct-a', 'Alice Park', 'a@example.com'),
    share('acct-d', 'Dana Reyes', 'd@example.com')
  ]
})

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function seeded(): BotItemsStore {
  const store = BotItemsStore.open(':memory:')
  stores.push(store)
  const add = (title: string, actsForAccount: string | null): string =>
    store.add(
      {
        ownerBotId: 'bot-1',
        chatId: 'chat-1',
        source: { kind: 'home', title: null },
        actsForAccounts: actsForAccount === null ? null : [actsForAccount],
        title,
        status: 'working',
        links: []
      },
      AGENT
    ).uid
  add('Mine', null)
  add('Alice open', 'acct-a')
  store.set(add('Alice closed', 'acct-a'), { status: 'done', note: 'Shipped' }, AGENT)
  return store
}

async function list(
  store: BotItemsStore,
  person?: string | null
): Promise<{ items: BotItem[]; counts: Record<string, number> }> {
  const method = BOT_ITEMS_OWNER_METHODS.find((entry) => entry.name === 'bots.items.owner.list')!
  const context = {
    runtime: {
      bots: { assertEnabled: () => {}, list: () => [BOT] },
      botItems: {
        store: () => store,
        views: async (records: readonly BotItemRecord[]) =>
          records.map((record) => ({ uid: record.uid, title: record.title, status: record.status }))
      }
    }
  }
  const params = method.params.parse({
    botId: 'bot-1',
    ...(person !== undefined ? { person } : {})
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these context parts
  const rpcContext = context as unknown as RpcContext
  return await method.handler(params, rpcContext)
}

const rows = (read: { items: BotItem[] }): string[] =>
  read.items.map((item) =>
    item.people ? `${item.title} · ${item.people.map((p) => p.name).join(', ')}` : item.title
  )

it("lists the owner's own items alone, counts included", async () => {
  const read = await list(seeded(), null)
  expect(rows(read)).toEqual(['Mine'])
  expect(read.counts).toEqual({ working: 1 })
})

it("lists everyone's, each teammate's item naming them and the owner's unmarked", async () => {
  const read = await list(seeded())
  expect(rows(read).toSorted()).toEqual([
    'Alice closed · Alice Park',
    'Alice open · Alice Park',
    'Mine'
  ])
  expect(read.counts).toEqual({ working: 2, done: 1 })
})

it("lists a picked teammate's items alone, and none for one with no items", async () => {
  const store = seeded()
  const alice = await list(store, 'acct-a')
  expect(rows(alice).toSorted()).toEqual(['Alice closed · Alice Park', 'Alice open · Alice Park'])
  expect(alice.counts).toEqual({ working: 1, done: 1 })
  expect(await list(store, 'acct-d')).toMatchObject({ items: [], counts: {} })
})

it("counts only the owner's own Needs you for the badge, the same items the default list shows", async () => {
  const store = seeded()
  const ask = (title: string, accounts: string[] | null): void => {
    const { uid } = store.add(
      {
        ownerBotId: 'bot-1',
        chatId: 'chat-1',
        source: { kind: 'home', title: null },
        actsForAccounts: accounts,
        title,
        status: 'working',
        links: []
      },
      AGENT
    )
    store.set(uid, { status: 'needs_you', comment: 'Which one?' }, AGENT)
  }
  ask('Mine to answer', null)
  ask('Alice to answer', ['acct-a'])
  const badge = store.needsYou(botItemListScope(botItemsOfPeople(null)))
  expect(badge).toHaveLength(1)
  expect((await list(store, null)).counts.needs_you).toBe(badge.length)
  expect(store.needsYou(botItemListScope({ kind: 'everyone' }))).toHaveLength(2)
})

it("writes the owner's own panel actions as the owner, naming no teammate", () => {
  const runtime = { bots: { assertEnabled: () => {} } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownerActor reads only the caller, scope, device and assertEnabled
  const owner = { runtime } as unknown as RpcContext
  expect(ownerActor(owner)).toEqual({ kind: 'owner' })
  expect(ownerActor({ ...owner, pairedDeviceId: 'phone' })).toEqual({
    kind: 'owner',
    device: 'phone'
  })
})
