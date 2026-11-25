import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { resolveItem } from '../runtime/rpc/methods/bots-items-write-support'
import SyncDatabase from '../sqlite/sync-database'
import { botItemAccessOfCaller, botItemListScope } from './bot-item-access'
import { BOT_ITEMS_MIGRATIONS } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import { botShareAsker } from './team-share/bot-share-chats'

const OWNER_CHAT = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_CHAT = '22222222-2222-4222-8222-222222222222'

let directory = ''
let db: OrchestrationDb

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-item-access-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  db.recordBotConversationActsFor(OWNER_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  db.recordBotConversationActsFor(TEAMMATE_CHAT, {
    actsFor: [
      botShareAsker({ kind: 'bot-share', botId: 'bot-1', accountId: 'acct-2', name: 'Kim' })
    ]
  })
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

it("reads an item from before teammates as the owner's: his chats reach it, a teammate's never", async () => {
  // An items file as the build before this one left it, with one item.
  const path = join(directory, 'bot-items.sqlite')
  const old = new SyncDatabase(path)
  BOT_ITEMS_MIGRATIONS.slice(0, 4).forEach((step) => old.exec(step))
  old.exec(`PRAGMA user_version = 4`)
  old.exec(`INSERT INTO items (uid, number, owner_bot_id, chat_id, source, title, status, version,
    last_event_id, last_activity_at, created_at, updated_at)
    VALUES ('u1', 7, 'bot-1', '${OWNER_CHAT}', '{"kind":"home","title":null}', 'Old work', 'working',
    0, 0, 1, 1, 1)`)
  old.close()

  const store = BotItemsStore.open(path)
  try {
    expect(store.get('u1')?.actsForAccount).toBeNull()
    const sources = {
      getOrchestrationDb: () => db,
      listAutomationRuns: () => [],
      showAutomation: () => {
        throw new Error('none')
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveItem reads only these two store calls
    const remote = {
      byNumber: async (number: number) => store.byNumber(number),
      get: async (uid: string) => store.get(uid)
    } as never
    const owner = botItemAccessOfCaller(sources, { sessionId: OWNER_CHAT })
    const teammate = botItemAccessOfCaller(sources, { sessionId: TEAMMATE_CHAT })
    const share = botItemAccessOfCaller(sources, {
      share: { kind: 'bot-share', botId: 'bot-1', accountId: 'acct-2', name: 'Kim' }
    })

    expect((await resolveItem(remote, '7', owner)).uid).toBe('u1')
    await expect(resolveItem(remote, '7', teammate)).rejects.toThrow('No item 7')
    await expect(resolveItem(remote, 'u1', share)).rejects.toThrow('was never made')
    const listed = (access: typeof owner) =>
      store.list({ botId: 'bot-1', statuses: ['working'], limit: 10, ...botItemListScope(access) })
    expect(listed(owner).items.map((item) => item.uid)).toEqual(['u1'])
    expect(listed(teammate)).toEqual({ items: [], counts: {} })
  } finally {
    store.dispose()
  }
})
