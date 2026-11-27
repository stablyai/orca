// #49868: the journal looks up each close it writes by its item and close time. Guards that lookup:
// it seeks the close by index, so the events SQLite tests stay the same however many came after it.
// The tally is a SQL function SQLite calls for each event it tests as the close, on a database the
// test opens itself over a file the store set up.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { BotItemsStore } from './bot-items-store'
import type { BotItemBotActor } from './bot-items-input'

const HOME: BotItemBotActor = { kind: 'bot', botId: 'b1', chatId: 'home' }
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('tests the same events to find a close however many events came after it', () => {
  const lookup = (after: number) => {
    const directory = mkdtempSync(join(tmpdir(), 'bot-items-closes-'))
    directories.push(directory)
    const path = join(directory, 'bot-items.sqlite')
    BotItemsStore.open(path).dispose()
    const db = new SyncDatabase(path)
    // Thousands of one-event writes: no disk sync each, or slow disks time the test out.
    db.pragma('synchronous = OFF')
    let tested = 0
    db.function('tested', () => ((tested += 1), 1))
    const prepare = db.prepare.bind(db)
    const status = "kind = 'status'"
    db.prepare = (sql: string) => prepare(sql.replaceAll(status, `tested() AND ${status}`))
    const store = new BotItemsStore(db, false)
    try {
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
      tested = 0
      return { found: store.closes([{ uid, closedAt }])[uid]?.actsFor, tested }
    } finally {
      store.dispose()
    }
  }
  expect([lookup(300), lookup(3_000)]).toEqual([
    { found: [{ kind: 'owner' }], tested: 1 },
    { found: [{ kind: 'owner' }], tested: 1 }
  ])
})
