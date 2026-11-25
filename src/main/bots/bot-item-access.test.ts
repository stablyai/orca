import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { OrchestrationSessionCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { resolveItem } from '../runtime/rpc/methods/bots-items-write-support'
import SyncDatabase from '../sqlite/sync-database'
import {
  botItemAccessOfCaller,
  botItemAccessOfChat,
  botItemAddedFor,
  botItemListScope,
  type BotItemAccess
} from './bot-item-access'
import { BOT_ITEMS_MIGRATIONS } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import { botShareAsker } from './team-share/bot-share-chats'

const OWNER_CHAT = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_CHAT = '22222222-2222-4222-8222-222222222222'
const SLACK_CHAT = '33333333-3333-4333-8333-333333333333'
const SHARED_CHAT = '44444444-4444-4444-8444-444444444444'
const WORKER = '55555555-5555-4555-8555-555555555555'

const teammate = (accountId: string): BotRequestAsker =>
  botShareAsker({ kind: 'bot-share', botId: 'bot-1', accountId, name: accountId })

let directory = ''
let db: OrchestrationDb
let store: BotItemsStore
const sources = {
  getOrchestrationDb: () => db,
  listAutomationRuns: () => [],
  showAutomation: () => {
    throw new Error('none')
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-item-access-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  db.recordBotConversationActsFor(OWNER_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  db.recordBotConversationActsFor(TEAMMATE_CHAT, { actsFor: [teammate('acct-2')] })
  // acct-2's linked Slack login, as the cloud stamps it.
  db.recordBotConversationActsFor(SLACK_CHAT, {
    actsFor: [
      {
        kind: 'person',
        source: 'slack',
        userId: 'U2',
        name: 'Kim',
        workspaceId: 'T1',
        role: 'member',
        viaAccount: 'acct-2'
      }
    ]
  })
  db.recordBotConversationActsFor(SHARED_CHAT, {
    actsFor: [teammate('acct-2'), teammate('acct-3')]
  })
  store = BotItemsStore.open(':memory:')
})
afterEach(() => {
  store.dispose()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: access reads the session id, and the dispatch lookup its address and pane
const caller = (sessionId: string) =>
  ({
    sessionId,
    orcaSessionId: sessionId,
    address: `orca_session_id:${sessionId}`,
    terminalHandle: null,
    paneKey: null,
    workspaceId: 'workspace'
  }) as unknown as OrchestrationSessionCaller

function addItem(title: string, actsForAccounts: readonly string[] | null): void {
  store.add(
    {
      ownerBotId: 'bot-1',
      chatId: OWNER_CHAT,
      source: { kind: 'home', title: null },
      actsForAccounts,
      title,
      status: 'working',
      links: []
    },
    { kind: 'bot', botId: 'bot-1', chatId: OWNER_CHAT }
  )
}

const listed = (access: BotItemAccess) =>
  store
    .list({ botId: 'bot-1', statuses: ['working'], limit: 10, ...botItemListScope(access) })
    .items.map((item) => item.title)
    .toSorted()

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

  const upgraded = BotItemsStore.open(path)
  try {
    expect(upgraded.get('u1')?.actsForAccounts).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveItem reads only these two store calls
    const remote = {
      byNumber: async (number: number) => upgraded.byNumber(number),
      get: async (uid: string) => upgraded.get(uid)
    } as never
    const owner = botItemAccessOfCaller(sources, { sender: caller(OWNER_CHAT) })
    const theirs = botItemAccessOfCaller(sources, { sender: caller(TEAMMATE_CHAT) })
    const share = botItemAccessOfCaller(sources, {
      share: { kind: 'bot-share', botId: 'bot-1', accountId: 'acct-2', name: 'Kim' }
    })
    expect((await resolveItem(remote, '7', owner)).uid).toBe('u1')
    await expect(resolveItem(remote, '7', theirs)).rejects.toThrow('No item 7')
    await expect(resolveItem(remote, 'u1', share)).rejects.toThrow('was never made')
  } finally {
    upgraded.dispose()
  }
})

it('gives a worker what the chat that started it reaches, and none when no chat did', () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Look into it' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'claude' }
  })
  const assign = (creator: string | null) =>
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET creator_orca_session_id = ?, assignee_handle = ? WHERE id = ?'
      )
      .run(creator, `orca_session_id:${WORKER}`, dispatch.id)

  assign(TEAMMATE_CHAT)
  expect(listed(botItemAccessOfCaller(sources, { sender: caller(WORKER) }))).toEqual(['Kim work'])
  assign(null)
  expect(listed(botItemAccessOfCaller(sources, { sender: caller(WORKER) }))).toEqual([])
})

it("decides a chat's people the same for every channel, and a shared chat never reaches the owner's", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  addItem('Lee work', ['acct-3'])
  addItem('Other teammate work', ['acct-4'])

  expect(listed(botItemAccessOfChat(sources, SLACK_CHAT))).toEqual(['Kim work'])
  expect(listed(botItemAccessOfChat(sources, SHARED_CHAT))).toEqual(['Kim work', 'Lee work'])
  expect(listed(botItemAccessOfChat(sources, OWNER_CHAT))).toHaveLength(4)
})

it('makes an item added for another chat act for that chat, and only from a chat that reaches it', () => {
  const owner = botItemAccessOfChat(sources, OWNER_CHAT)
  const theirs = botItemAccessOfChat(sources, TEAMMATE_CHAT)
  expect(botItemAddedFor(sources, owner, TEAMMATE_CHAT)).toEqual(['acct-2'])
  expect(botItemAddedFor(sources, theirs, SLACK_CHAT)).toEqual(['acct-2'])
  expect(() => botItemAddedFor(sources, theirs, OWNER_CHAT)).toThrow('for someone else')
  expect(() => botItemAddedFor(sources, theirs, SHARED_CHAT)).not.toThrow()
})
