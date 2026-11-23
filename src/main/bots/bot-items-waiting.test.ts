import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import type { BotItemBotActor } from './bot-items-input'
import { BOT_ITEMS_MIGRATIONS, migrateBotItems } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }

describe('Waiting items', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  function open(): BotItemsStore {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    return store
  }

  function addWorking(store: BotItemsStore): string {
    return store.add(
      {
        ownerBotId: BOT.botId,
        chatId: BOT.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      BOT
    ).uid
  }

  function waitText(store: BotItemsStore, uid: string): string | null {
    const item = store.get(uid)!
    const event = item.waitEvent === null ? undefined : store.events(uid, item.waitEvent - 1, 1)[0]
    return item.status === 'waiting' && typeof event?.data.note === 'string'
      ? event.data.note
      : null
  }

  it('keeps an older file’s items and links through the migration that adds Waiting', () => {
    const db = new SyncDatabase(':memory:')
    for (const [step, sql] of BOT_ITEMS_MIGRATIONS.slice(0, 3).entries()) {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${step + 1}`)
    }
    db.exec(`INSERT INTO items (uid, number, owner_bot_id, chat_id, source, title, status, version,
        last_event_id, last_activity_at, created_at, updated_at, others_last_event_id, snoozed_until)
      VALUES ('u1', 7, 'bot', 'home', '{"kind":"home"}', 'Old', 'needs_you', 3, 9, 100, 50, 100, 8, 500)`)
    db.exec(`INSERT INTO item_links VALUES ('u1', 'pr', 'acme/app#1', 2)`)
    expect(migrateBotItems(db)).toBe(true)
    const store = new BotItemsStore(db, false)
    stores.push(store)
    expect(store.get('u1')).toMatchObject({
      number: 7,
      status: 'needs_you',
      snoozedUntil: 500,
      lastEventId: 9,
      waitEvent: null
    })
    expect(store.links('u1')).toEqual([
      { itemUid: 'u1', kind: 'pr', ref: 'acme/app#1', addedEvent: 2 }
    ])
    store.link('u1', [{ kind: 'automation', ref: 'auto-1' }], BOT)
    expect(
      store
        .links('u1')
        .map((link) => link.kind)
        .sort()
    ).toEqual(['automation', 'pr'])
  })

  it('needs what it waits on, keeps it through comments, and ends when its bot starts a worker', () => {
    const store = open()
    const uid = addWorking(store)
    expect(() => store.set(uid, { status: 'waiting' }, BOT)).toThrow(/needs --note/)
    expect(() => store.set(uid, { status: 'waiting', note: 'a\nb' }, BOT)).toThrow(/one line/)
    store.set(uid, { status: 'waiting', note: 'CI on #47193' }, BOT)
    store.comment(uid, 'CI is still running.', BOT)
    expect(waitText(store, uid)).toBe('CI on #47193')
    store.set(uid, { status: 'waiting', note: 'Review on #47193' }, BOT)
    expect(waitText(store, uid)).toBe('Review on #47193')
    store.linkStartedWorker(uid, 'ctx_fix', BOT)
    expect(store.get(uid)).toMatchObject({ status: 'working', waitEvent: null })
  })

  it('never hides the owner’s open question behind Waiting', () => {
    const store = open()
    const uid = addWorking(store)
    store.set(uid, { status: 'needs_you', comment: 'Which branch?' }, BOT)
    expect(() => store.set(uid, { status: 'waiting', note: 'CI' }, BOT)).toThrow(/stays Needs you/)
    expect(store.get(uid)!.status).toBe('needs_you')
  })

  it('takes back only its own usage-limit wait', () => {
    const store = open()
    const mine = addWorking(store)
    const bots = addWorking(store)
    store.usageLimitWait(mine, 'Claude usage resets Nov 26, 9:00 AM')
    expect(waitText(store, mine)).toBe('Claude usage resets Nov 26, 9:00 AM')
    store.set(bots, { status: 'waiting', note: 'Deploy of #9' }, BOT)
    store.usageLimitWait(mine, null)
    store.usageLimitWait(bots, null)
    expect(store.get(mine)!.status).toBe('working')
    expect(waitText(store, bots)).toBe('Deploy of #9')
  })
})
