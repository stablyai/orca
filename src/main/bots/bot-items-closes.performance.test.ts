// #49868, #49882: the journal reads each item's closes since its last pass, and each close is
// numbered when it is made. Guards both: each seeks status events by index, so the events SQLite
// tests stay the same however many came before the pass (earlier closes and reopens) or after the
// close (comments). The tally is a SQL function SQLite calls for each status event it tests, on a
// database the test opens itself over a file the store set up.
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

it('tests the same events to number a close and find it, however many events came before or after', () => {
  const lookup = (history: number) => {
    const directory = mkdtempSync(join(tmpdir(), 'bot-items-closes-'))
    directories.push(directory)
    const path = join(directory, 'bot-items.sqlite')
    BotItemsStore.open(path).dispose()
    const db = new SyncDatabase(path)
    let tested = 0
    db.function('tested', () => ((tested += 1), 1))
    const prepare = db.prepare.bind(db)
    const status = "kind = 'status'"
    db.prepare = (sql: string) => prepare(sql.replaceAll(status, `tested() AND ${status}`))
    const store = new BotItemsStore(db, false)
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
    // Closed and reopened before the journal's last pass.
    for (let i = 0; i < history; i++) {
      store.close(uid, 'done', undefined, HOME, [{ kind: 'owner' }], at++)
      store.ownerStatus({ uids: [uid], to: 'working' }, { kind: 'owner' }, at++)
    }
    const since = at++
    tested = 0
    store.close(uid, 'done', undefined, HOME, [{ kind: 'owner' }], at++)
    const numbered = tested
    for (let i = 0; i < history; i++) {
      store.comment(uid, 'More', HOME, [], at++)
    }
    tested = 0
    const found = store.closes([{ uid, since }])[uid]?.map((close) => close.closeNumber)
    store.dispose()
    return { numbered, found, tested }
  }
  expect([lookup(200), lookup(2_000)]).toEqual([
    { numbered: 2, found: [201], tested: 1 },
    { numbered: 2, found: [2_001], tested: 1 }
  ])
})
