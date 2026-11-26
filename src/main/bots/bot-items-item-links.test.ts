import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { BotItemSchema } from '../../shared/bots/bot-item-schema'
import type { BotItemBotActor } from './bot-items-input'
import type { BotItemsRemote } from './bot-items-ops'
import { BOT_ITEMS_MIGRATIONS, migrateBotItems } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import { itemLinksByUid, parseItemLink } from '../runtime/rpc/methods/bots-items-write-support'

const BACKEND: BotItemBotActor = { kind: 'bot', botId: 'backend', chatId: 'backend-home' }
const QA: BotItemBotActor = { kind: 'bot', botId: 'qa', chatId: 'qa-home' }

describe('item links', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function add(store: BotItemsStore, actor: BotItemBotActor, title: string): string {
    return store.add(
      {
        ownerBotId: actor.botId,
        chatId: actor.chatId,
        source: { kind: 'home', title: null },
        title,
        status: 'working',
        links: []
      },
      actor
    ).uid
  }

  function remote(store: BotItemsStore): BotItemsRemote {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: itemLinksByUid reads only these.
    return {
      byNumber: async (n: number) => store.byNumber(n),
      get: async (uid: string) => store.get(uid)
    } as unknown as BotItemsRemote
  }

  it('keeps an older file’s links through the migration that adds item links', () => {
    const db = new SyncDatabase(':memory:')
    for (const [step, sql] of BOT_ITEMS_MIGRATIONS.slice(0, 4).entries()) {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${step + 1}`)
    }
    db.exec(`INSERT INTO items (uid, number, owner_bot_id, chat_id, source, title, status, version,
        last_event_id, last_activity_at, created_at, updated_at)
      VALUES ('u1', 7, 'qa', 'qa-home', '{"kind":"home"}', 'Old', 'working', 1, 1, 1, 1, 1)`)
    db.exec(`INSERT INTO item_links VALUES ('u1', 'automation', 'auto-1', 1)`)
    expect(() => db.exec(`INSERT INTO item_links VALUES ('u1', 'item', 'u2', 1)`)).toThrow()
    expect(migrateBotItems(db)).toBe(true)
    const store = new BotItemsStore(db, false)
    stores.push(store)
    store.link('u1', [{ kind: 'item', ref: 'u2' }], QA)
    expect(store.links('u1').map((link) => `${link.kind}:${link.ref}`)).toEqual([
      'automation:auto-1',
      'item:u2'
    ])
  })

  it('stores another bot’s item by uid however it was named, never itself or one not there', async () => {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    const backend = add(store, BACKEND, 'Release API')
    const qa = add(store, QA, 'Verify the release')
    const number = store.get(backend)!.number
    const link = (ref: string) => itemLinksByUid(remote(store), [parseItemLink(ref)], qa)

    expect(await link(`item:${number}`)).toEqual([{ kind: 'item', ref: backend }])
    expect(await link(` item:${backend} `)).toEqual([{ kind: 'item', ref: backend }])
    await expect(link('item:999')).rejects.toThrow(/no such item/)
    await expect(link(`item:${qa}`)).rejects.toThrow(/can't link itself/)

    store.link(qa, await link(`item:${number}`), QA)
    expect(store.viewRows([qa]).linked).toEqual({
      [backend]: { number, ownerBotId: 'backend', title: 'Release API', status: 'working' }
    })
    // Backlinks: what `item list --link` lists, and whom a change to the target re-reads.
    const backlink = { kind: 'item' as const, ref: backend }
    const listed = store.list({ botId: 'qa', statuses: ['working'], link: backlink, limit: 10 })
    expect(listed.items.map((item) => item.uid)).toEqual([qa])
    expect(store.itemsLinkingItems([backend])).toEqual([{ uid: qa, ownerBotId: 'qa' }])
  })

  it('reaches a client: its parse keeps the link, and an unreadable target as not found', () => {
    const item = {
      uid: 'qa-1',
      number: 19,
      owner: { botId: 'qa', name: 'QA' },
      title: 'Verify the release',
      description: null,
      doneMeans: null,
      status: 'working',
      chat: { id: 'qa-home', kind: 'home', title: null },
      madeBy: null,
      question: null,
      closeNote: null,
      wait: null,
      version: 1,
      lastEventId: 'e1',
      othersLastEventId: 'e0',
      snoozedUntil: null,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
      closedAt: null
    }
    const target = {
      number: 4,
      owner: { botId: 'backend', name: 'Backend' },
      title: 'Release API',
      status: 'done'
    }
    const parsed = BotItemSchema.parse({
      ...item,
      links: [
        { kind: 'item', ref: 'backend-4', item: target },
        { kind: 'item', ref: 'gone', item: { ...target, status: 'someday' } }
      ]
    })
    expect(parsed.links).toEqual([
      { kind: 'item', ref: 'backend-4', item: target },
      { kind: 'item', ref: 'gone', item: null }
    ])
  })
})
