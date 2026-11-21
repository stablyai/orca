import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  scaleDirectory,
  scaleRecord
} from '../runtime/agent-session/records/agent-session-scale.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import {
  conversationRecordReader,
  type AgentSessionRecordReader
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import Database from '../sqlite/sync-database'
import type { BotChatTreeHost } from './bot-chat-tree-host'
import { readBotChatInputs } from './bot-chat-tree-base'
import { createBotChatTreeIndex, type BotChatTreeIndex } from './bot-chat-tree-index'
import { BotLookAroundStore } from './bot-look-around-store'
import { makeTestBot } from './bot.test-fixture'

const botA = makeTestBot({
  id: 'bot-a',
  folderWorkspaceId: 'home-a',
  chatSessionId: 'chat-bot-a-1'
})
const botB = makeTestBot({
  id: 'bot-b',
  folderWorkspaceId: 'home-b',
  chatSessionId: 'chat-bot-b-1'
})
const homeA = folderWorkspaceKey('home-a')
const homeB = folderWorkspaceKey('home-b')

function chatRecord(sessionId: string, workspaceId: string, name: string) {
  return {
    ...scaleRecord(sessionId, workspaceId),
    conversationName: name,
    lastTurn: { state: 'settled' as const, at: 1, reply: 'Done.' }
  }
}

const opened: { close: () => void }[] = []
afterEach(() => opened.splice(0).forEach((item) => item.close()))

async function rig(read?: readonly (typeof botA)[], extraBots = 0) {
  const others = Array.from({ length: extraBots }, (_, i) =>
    makeTestBot({ id: `bot-x${i}`, folderWorkspaceId: `home-x${i}`, chatSessionId: `chat-x${i}` })
  )
  const bots = [botA, botB, ...others]
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, {
    records: [
      chatRecord('chat-bot-a-1', homeA, 'Home'),
      chatRecord('chat-bot-a-2', homeA, 'Release notes'),
      chatRecord('chat-bot-b-1', homeB, 'Home'),
      chatRecord('chat-elsewhere', 'workspace-elsewhere', 'Elsewhere'),
      ...others.map((bot, i) =>
        chatRecord(`chat-x${i}`, folderWorkspaceKey(bot.folderWorkspaceId), 'Home')
      )
    ]
  })
  const store = await openTestAgentSessionRecordStore(root)
  // The store keeps the tab table; record writes go to these rows, published as a commit publishes
  // them: a new row per write, then the written ids.
  const rows = new Map(store.listConversations().map((row) => [row.sessionId, row]))
  const listeners = new Set<(ids: readonly string[], tabsChanged: boolean) => void>()
  const records: AgentSessionRecordReader = {
    ...conversationRecordReader(store),
    getRecord: (sessionId) => rows.get(sessionId) ?? null,
    listRecords: () => [...rows.values()],
    onRecordsChanged: (listener) => {
      listeners.add(listener)
      const stopTabs = store.onRecordsChanged(listener)
      return () => {
        listeners.delete(listener)
        stopTabs()
      }
    },
    conversationCount: () => rows.size,
    recordStamp: (sessionId) => rows.get(sessionId)
  }
  const commit = async (sessionId: string, row?: AgentSessionConversationView) => {
    if (row) {
      rows.set(sessionId, row)
    } else {
      rows.delete(sessionId)
    }
    listeners.forEach((listener) => listener([sessionId], false))
  }
  const db = new OrchestrationDb(join(root, 'orchestration.db'))
  opened.push(db)
  const host: Pick<BotChatTreeHost, 'externalConversations' | 'automations' | 'automationRuns'> = {
    externalConversations: () => [],
    automations: () => [],
    automationRuns: () => new Map()
  }
  const notices: BotChangeScope[] = []
  const index: BotChatTreeIndex = createBotChatTreeIndex({
    bots: () => bots,
    records: () => records,
    db: () => db,
    backgroundRuns: new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {}),
    inputs: (bot) => readBotChatInputs(host, bot),
    changed: (scope) => notices.push(scope)
  })
  opened.push({ close: () => index.dispose() })
  db.workerStatusListener = (id, change) => index.dispatchLinkChanged(id, change)
  /** Writes a chat's row as a commit would: a rename, a new chat (from a seeded row), or a move. */
  const put = (sessionId: string, workspaceId: string, name: string) => {
    const template = rows.get(sessionId) ?? rows.get('chat-bot-a-1')!
    return commit(sessionId, {
      ...template,
      sessionId,
      location: { ...template.location, workspaceId },
      conversationName: name
    })
  }
  // A lease renewal rewrites the row with nothing a chat list shows.
  const renew = (sessionId: string) => commit(sessionId, { ...rows.get(sessionId)! })
  const remove = (sessionId: string) => commit(sessionId)
  const dispatch = (
    id: string,
    creator: string,
    assignee: string | null,
    status = 'dispatched'
  ) => {
    db.db
      .prepare("INSERT INTO tasks (id, spec, task_title, status) VALUES (?, 'spec', ?, 'pending')")
      .run(`task-${id}`, `Task ${id}`)
    db.db
      .prepare(
        'INSERT INTO dispatch_contexts (id, task_id, creator_orca_session_id, assignee_orca_session_id, status) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, `task-${id}`, creator, assignee, status)
  }
  /** Lets the Dispatch notices, read after the write's transaction, go out. */
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const titles = (botId: string) =>
    [...index.base(botId === botA.id ? botA : botB).chats.values()]
      .map((chat) => `${chat.chatId}:${chat.title}`)
      .sort()
  const dispatches = (bot: typeof botA) =>
    index
      .base(bot)
      .placement.dispatches()
      .map((entry) => `${entry.id}@${entry.chatId}:${entry.settled ? 'settled' : 'running'}`)
      .sort()
  const expectSameAsFullBuild = () => {
    for (const bot of bots) {
      expect(index.verify(bot.id).drift).toBe(false)
    }
    expect(index.drift.count).toBe(0)
  }
  // Each bot is read once, as its sidebar does.
  ;(read ?? bots).forEach((bot) => index.base(bot))
  return {
    index,
    notices,
    store,
    put,
    renew,
    remove,
    dispatch,
    settle,
    titles,
    dispatches,
    expectSameAsFullBuild,
    db,
    dbPath: join(root, 'orchestration.db')
  }
}

describe('BotChatTreeIndex', () => {
  it("keeps each bot's chats as a full build has them across rename, create, delete and move", async () => {
    const r = await rig()
    await r.put('chat-bot-a-2', homeA, 'Release notes v2')
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['chats'] }])
    expect(r.titles('bot-a')).toEqual(['chat-bot-a-1:Home Chat', 'chat-bot-a-2:Release notes v2'])

    await r.put('chat-bot-a-3', homeA, 'Triage')
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['chats'] }])
    expect(r.titles('bot-a')).toContain('chat-bot-a-3:Triage')

    await r.remove('chat-bot-a-2')
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['chats'] }])
    expect(r.titles('bot-a')).toEqual(['chat-bot-a-1:Home Chat', 'chat-bot-a-3:Triage'])

    // A chat moved from one bot's home to the other's leaves one bot and joins the other.
    await r.put('chat-bot-a-3', homeB, 'Triage')
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a', 'bot-b'], kinds: ['chats'] }])
    expect(r.titles('bot-a')).toEqual(['chat-bot-a-1:Home Chat'])
    expect(r.titles('bot-b')).toEqual(['chat-bot-a-3:Triage', 'chat-bot-b-1:Home Chat'])
    r.expectSameAsFullBuild()
  })

  it('tells only the bot whose kept chat tab closed or reopened', async () => {
    const botCount = 10
    const r = await rig(undefined, botCount - 2)
    await r.store.setSessionTabVisibility('chat-bot-a-2', true)
    await r.store.setSessionTabVisibility('chat-elsewhere', true)
    r.notices.splice(0)
    await r.store.setSessionTabVisibility('chat-bot-a-2', false)
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['chats'] }])
    expect(r.index.base(botA).chats.get('chat-bot-a-2')?.closed).toBe(true)
    // A tab in no bot's home tells no bot.
    await r.store.setSessionTabVisibility('chat-elsewhere', false)
    await r.store.setSessionTabVisibility('chat-elsewhere', true)
    expect(r.notices.splice(0)).toEqual([])
    await r.store.setSessionTabVisibility('chat-bot-a-2', true)
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['chats'] }])
    expect(r.index.base(botA).chats.get('chat-bot-a-2')?.closed).toBe(false)
    r.expectSameAsFullBuild()
  })

  it('publishes no notice for a lease renewal or commits outside bot homes', async () => {
    const r = await rig()
    await r.renew('chat-bot-a-2')
    expect(r.notices.splice(0)).toEqual([])
    r.expectSameAsFullBuild()

    await r.put('chat-elsewhere', 'workspace-elsewhere', 'Renamed')
    await r.put('chat-new-elsewhere-1', 'workspace-elsewhere', 'New')
    expect(r.notices).toEqual([])
    r.expectSameAsFullBuild()
  })

  it("places a bot's new, settled and nested workers under the chat that started them", async () => {
    const r = await rig()
    r.dispatch('ctx-1', 'chat-bot-a-1', 'worker-session-1')
    await r.settle()
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['workers'] }])
    // A worker's own worker belongs to the chat its first ancestor credits.
    r.dispatch('ctx-2', 'worker-session-1', null)
    await r.settle()
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['workers'] }])
    r.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'ctx-1'").run()
    await r.settle()
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-a'], kinds: ['workers'] }])
    expect(r.dispatches(botA)).toEqual(['ctx-1@chat-bot-a-1:settled', 'ctx-2@chat-bot-a-1:running'])
    expect(r.dispatches(botB)).toEqual([])
    // A worker another bot's chat started is none of this bot's.
    r.dispatch('ctx-3', 'chat-bot-b-1', null)
    r.dispatch('ctx-4', 'chat-elsewhere', null)
    await r.settle()
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-b'], kinds: ['workers'] }])
    r.expectSameAsFullBuild()
  })

  it("tells a bot never read of its worker's settle, so a reader of its Activity sees it", async () => {
    const r = await rig([botA])
    // Started before this run of the host: no trigger told the index of it.
    const listener = r.db.workerStatusListener
    r.db.workerStatusListener = undefined
    r.dispatch('ctx-1', 'chat-bot-b-1', 'worker-session-1')
    r.db.workerStatusListener = listener
    r.db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'ctx-1'").run()
    await r.settle()
    expect(r.notices.splice(0)).toEqual([{ botIds: ['bot-b'], kinds: ['workers'] }])
    // Every bot is now read: a settle no bot owns tells nobody.
    r.dispatch('ctx-2', 'chat-elsewhere', null)
    await r.settle()
    expect(r.notices).toEqual([])
    r.expectSameAsFullBuild()
  })

  it('tells every bot when an orchestration reset deletes its workers, and drops them', async () => {
    const r = await rig()
    r.dispatch('ctx-1', 'chat-bot-a-1', 'worker-session-1')
    await r.settle()
    r.notices.splice(0)
    r.db.resetTasks()
    await r.settle()
    expect(r.notices).toEqual([{ kinds: ['workers'] }])
    expect(r.dispatches(botA)).toEqual([])
    r.expectSameAsFullBuild()
  })

  it("tells a bot's readers when its full check finds drift a commit never announced", async () => {
    const r = await rig()
    r.dispatch('ctx-1', 'chat-bot-a-1', null)
    await r.settle()
    r.notices.splice(0)
    // Another connection's write runs no trigger of this one: the index never hears of it.
    const other = new Database(r.dbPath)
    other.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'ctx-1'").run()
    other.close()
    expect(r.index.verify('bot-a').drift).toBe(true)
    expect(r.notices).toEqual([{ botIds: ['bot-a'], kinds: ['chats', 'workers'] }])
    expect(r.dispatches(botA)).toEqual(['ctx-1@chat-bot-a-1:settled'])
  })
})
