import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BOT_CHAT_SEARCH_LIMIT } from '../../shared/bots/bot-chat-search'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  scaleDirectory,
  scaleRecord
} from '../runtime/agent-session/records/agent-session-scale.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { conversationRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import Database from '../sqlite/sync-database'
import {
  recentBotChatTreeParts,
  searchBotChats,
  type BotChatSearchHost
} from './bot-chat-search-host'
import { readBotChatTreeParts, type BotChatTreeHost } from './bot-chat-tree-host'
import { BotLookAroundStore } from './bot-look-around-store'
import { makeTestBot } from './bot.test-fixture'

const CHATS = 5_000
const WORKERS_PER_CHAT = 20
const chatId = (index: number) => `chat-${String(index).padStart(5, '0')}`

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

/** A bot with 5k chats in its home, each with 20 finished workers in the orchestration database. */
async function bigBotHost(): Promise<BotChatSearchHost> {
  const bot = makeTestBot({ folderWorkspaceId: 'home-1' })
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, {
    records: Array.from({ length: CHATS }, (_, index) => ({
      ...scaleRecord(chatId(index), folderWorkspaceKey(bot.folderWorkspaceId)),
      conversationName: `Release notes draft number ${index}`,
      lastTurn: {
        state: 'settled' as const,
        at: index,
        reply: 'Six PRs in flight; two merged this morning and one waits on review.'
      }
    }))
  })
  const records = conversationRecordReader(await openTestAgentSessionRecordStore(root))

  const path = join(root, 'orchestration.db')
  const db = new OrchestrationDb(path)
  opened.push(db)
  const raw = new Database(path)
  const task = raw.prepare(
    "INSERT INTO tasks (id, spec, task_title, status) VALUES (?, 'spec', ?, 'completed')"
  )
  const dispatch = raw.prepare(
    "INSERT INTO dispatch_contexts (id, task_id, creator_orca_session_id, status) VALUES (?, ?, ?, 'completed')"
  )
  raw.exec('BEGIN')
  for (let chat = 0; chat < CHATS; chat += 1) {
    for (let worker = 0; worker < WORKERS_PER_CHAT; worker += 1) {
      const id = `${chat}-${worker}`
      // One needle deep in the history, in a worker's title only.
      const needle = chat === 0 && worker === 0
      task.run(`task-${id}`, needle ? 'Fix the zebra import' : `PR ${worker}: relay auth`)
      dispatch.run(`ctx-${id}`, `task-${id}`, chatId(chat))
    }
  }
  raw.exec('COMMIT')
  raw.close()

  const tree: BotChatTreeHost = {
    bots: () => [bot],
    externalConversations: () => [],
    chatTabs: async () => [],
    statusRows: () => [],
    automations: () => [],
    automationRuns: () => new Map(),
    recordedWorkers: async () => [],
    sessionRecords: async () => records,
    db: () => db,
    dispatchWorkers: async () => [],
    backgroundRuns: new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  }
  return {
    ...tree,
    treeParts: recentBotChatTreeParts((botId) => readBotChatTreeParts(tree, { botId })),
    contentMatches: async () => []
  }
}

it('searches 5k chats x 20 workers on the host in under 50 ms once a typing burst has read the tree', async () => {
  const host = await bigBotHost()
  const search = (query: string) => searchBotChats(host, { botId: 'bot-1', query })

  const coldStarted = performance.now()
  const needle = await search('zebra')
  const cold = performance.now() - coldStarted
  expect(needle.matches).toEqual([{ chatId: chatId(0), workerKeys: ['worker:ctx-0-0'] }])
  expect(needle.chats[0]?.finished.map((worker) => worker.title)).toEqual(['Fix the zebra import'])
  const broad = await search('relay')
  expect(broad.matches).toHaveLength(BOT_CHAT_SEARCH_LIMIT)
  expect(broad.more).toBe(CHATS - BOT_CHAT_SEARCH_LIMIT)

  // Timing is the point here: the host runs this each time typing pauses.
  const runs: number[] = []
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now()
    await search(run % 2 ? 'relay' : 'zebra')
    runs.push(performance.now() - started)
  }
  const median = runs.toSorted((a, b) => a - b)[3]
  console.info(
    `[bots] bots.chats.search at 5k chats x 20 workers: first ${cold.toFixed(0)} ms (the tree read), then median ${median.toFixed(1)} ms`
  )
  expect(median).toBeLessThan(50)
})
