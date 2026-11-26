// #49900: the journal looks up each close it writes by its item and close time. Guards that lookup:
// it seeks the close by index, so the events SQLite tests stay the same however many came after it.
// The tally is a SQL function SQLite calls for each event it tests as the close.
import { afterEach, expect, it } from 'vitest'
import { BotItemsStore } from './bot-items-store'
import type { BotItemBotActor } from './bot-items-input'
import type SyncDatabase from '../sqlite/sync-database'

const HOME: BotItemBotActor = { kind: 'bot', botId: 'b1', chatId: 'home' }
const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

it('tests the same events to find a close however many events came after it', () => {
  const lookup = (after: number) => {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    let at = 1_000
    const uid = store.add(
      {
        ownerBotId: 'b1',
        chatId: 'home',
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      HOME,
      at++
    ).uid
    const closedAt = at++
    store.close(uid, 'done', undefined, HOME, [{ kind: 'owner' }], closedAt)
    for (let i = 0; i < after; i++) {
      store.comment(uid, 'More', HOME, [], at++)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches the store's own database to count its work.
    const db = (store as unknown as { db: SyncDatabase }).db
    let tested = 0
    db.function('tested', () => ((tested += 1), 1))
    const prepare = db.prepare.bind(db)
    const status = "kind = 'status'"
    db.prepare = (sql: string) => prepare(sql.replaceAll(status, `tested() AND ${status}`))
    const found = store.closes([{ uid, closedAt }])[uid]?.actsFor
    return { found, tested }
  }
  expect([lookup(1_000), lookup(10_000)]).toEqual([
    { found: [{ kind: 'owner' }], tested: 1 },
    { found: [{ kind: 'owner' }], tested: 1 }
  ])
})
