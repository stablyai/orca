// `bots.chats` closes a chat mail cannot reach; the tree closes only a chat that truly ended. Each row's
// literal verdicts here, with the rows' public shape, pin both.
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { structuredWorkerProcessIncarnation } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { listBotChats } from '../runtime/rpc/methods/bots-chats'
import { readBotChatTree, type BotChatTreeHost } from './bot-chat-tree-host'
import { BotLookAroundStore } from './bot-look-around-store'
import { makeTestBot } from './bot.test-fixture'

const bot = makeTestBot({ folderWorkspaceId: 'home-1', chatSessionId: 'chat-home' })
const HOME = folderWorkspaceKey(bot.folderWorkspaceId)
const AT = 1_700_000_000_000

let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  db = undefined
})

type RecordOptions = {
  name?: string
  at?: number
  clearedInto?: string
  otherHost?: boolean
}

/** A chat of the bot's home, settled after one turn, in the bot's home workspace. */
function chatRecord(sessionId: string, options: RecordOptions = {}): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return {
    ...base,
    location: {
      ...base.location,
      workspaceId: HOME,
      ...(options.otherHost ? { executionHostId: 'ssh:paired-linux' as const } : {})
    },
    conversationName: options.name ?? `Chat ${sessionId}`,
    lastTurn: {
      state: 'settled',
      at: options.at ?? AT,
      prompt: `Ask in ${sessionId}`,
      reply: `Reply from ${sessionId}`
    },
    ...(options.clearedInto
      ? {
          conversationCommand: {
            command: 'clear' as const,
            runtimeFence: 8,
            operationId: `op-clear-${sessionId}`,
            callerKey: 'renderer',
            phase: 'committed' as const,
            state: 'completed' as const,
            replacementSessionId: options.clearedInto
          }
        }
      : {})
  }
}

type StoreOptions = {
  /** Sessions with an open tab. */
  tabs?: readonly string[]
  /** Open chats with no tab. */
  background?: readonly string[]
  /** How the store answers tab visibility: the keyed API, the older index, or neither (an old store). */
  tabApi?: 'retired' | 'index' | 'none'
  indexPresent?: boolean
}

function storeOf(
  records: readonly AgentSessionRecord[],
  options: StoreOptions = {}
): AgentSessionRecordReader {
  const views = new Map(
    records.map((record) => [record.sessionId, agentSessionConversationView(record)])
  )
  const tabs = options.tabs ?? []
  const api = options.tabApi ?? 'retired'
  return {
    getRecord: (sessionId) => views.get(sessionId) ?? null,
    listRecords: () => [...views.values()],
    ...(api === 'retired'
      ? { isSessionTabRetired: (sessionId: string) => !tabs.includes(sessionId) }
      : {}),
    ...(api === 'index'
      ? {
          getVisibleSessionTabIndex: () => ({
            present: options.indexPresent ?? true,
            sessionIds: [...tabs]
          })
        }
      : {}),
    ...(options.background
      ? { isSessionInBackground: (sessionId: string) => options.background!.includes(sessionId) }
      : {})
  }
}

function statusRow(
  paneKey: string,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt: 10,
    stateStartedAt: 10,
    ...overrides
  }
}

function openDb(): OrchestrationDb {
  db = new OrchestrationDb(':memory:')
  return db
}

/** A structured worker this host recorded a Dispatch for but holds no terminal identity of: it can never read mail. */
function recordLostWorker(database: OrchestrationDb, sessionId: string): void {
  database.db
    .prepare(
      `INSERT INTO dispatch_contexts (id, task_id, status, assignee_orca_session_id, process_incarnation)
       VALUES ('ctx-lost', 't-lost', 'completed', ?, ?)`
    )
    .run(sessionId, structuredWorkerProcessIncarnation(sessionId))
}

const noRuns = () => new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})

function treeHost(
  store: AgentSessionRecordReader,
  database: OrchestrationDb,
  statusRows: readonly AgentStatusIpcPayload[] = []
): BotChatTreeHost {
  return {
    bots: () => [bot],
    externalConversations: () => [],
    chatTabs: async () => [],
    statusRows: () => statusRows,
    automations: () => [],
    automationRuns: () => new Map(),
    recordedWorkers: async () => [],
    sessionRecords: async () => store,
    db: () => database,
    dispatchWorkers: async () => [],
    backgroundRuns: noRuns()
  }
}

function row(id: string, overrides: Partial<BotChatRow> = {}): BotChatRow {
  return {
    id,
    title: `Chat ${id}`,
    lastActivityAt: AT,
    lastAsked: `Ask in ${id}`,
    lastSaid: `Reply from ${id}`,
    home: false,
    self: false,
    closed: false,
    ...overrides
  }
}

/** The Home row a bot without a Home Chat yet lists first; opening it starts one. */
const NO_HOME_YET = {
  chatId: '',
  title: 'Home Chat',
  origin: 'home',
  live: 'idle',
  lastActiveAt: 0,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0
}

/** What the tree says of one chat with no workers, no tab and no status row unless given. */
function treeChat(chatId: string, overrides: Record<string, unknown> = {}) {
  return {
    chatId,
    title: `Chat ${chatId}`,
    origin: 'side',
    live: 'idle',
    lastActiveAt: AT,
    unread: false,
    closed: false,
    tab: false,
    preview: `Reply from ${chatId}`,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...overrides
  }
}

type Case = {
  records: AgentSessionRecord[]
  store?: StoreOptions
  lostWorker?: string
  statusRows?: AgentStatusIpcPayload[]
  rows: BotChatRow[]
  chats: ReturnType<typeof treeChat>[]
}

const matrix: Record<string, Case> = {
  'reachable, tab open': {
    records: [chatRecord('chat-alpha')],
    store: { tabs: ['chat-alpha'] },
    rows: [row('chat-alpha')],
    chats: [treeChat('chat-alpha')]
  },
  'closed tab (retired), not background': {
    records: [chatRecord('chat-alpha')],
    store: { tabs: [] },
    rows: [row('chat-alpha', { closed: true, reason: 'ended' })],
    chats: [treeChat('chat-alpha', { closed: true, closedAt: AT })]
  },
  'background session (no tab)': {
    records: [chatRecord('chat-alpha')],
    store: { tabs: [], background: ['chat-alpha'] },
    rows: [row('chat-alpha')],
    chats: [treeChat('chat-alpha')]
  },
  'other-host lineage: mail refuses, the tree keeps it open and reads status from the live session':
    {
      records: [
        chatRecord('chat-alpha', { clearedInto: 'chat-beta' }),
        chatRecord('chat-beta', { otherHost: true })
      ],
      store: { tabs: ['chat-alpha', 'chat-beta'] },
      statusRows: [
        statusRow(structuredAgentSessionStatusPaneKey('chat-beta'), { stateStartedAt: 42 })
      ],
      rows: [
        row('chat-alpha', {
          title: 'Chat chat-beta',
          lastAsked: 'Ask in chat-beta',
          lastSaid: 'Reply from chat-beta',
          closed: true,
          reason: 'other-host'
        })
      ],
      chats: [
        treeChat('chat-alpha', {
          title: 'Chat chat-beta',
          preview: 'Reply from chat-beta',
          turnDone: { paneKey: structuredAgentSessionStatusPaneKey('chat-beta'), at: 42 }
        })
      ]
    },
  'a /clear whose successor has no record lists no chat': {
    records: [chatRecord('chat-alpha', { clearedInto: 'chat-missing-1' })],
    store: { tabs: ['chat-alpha'] },
    rows: [],
    chats: []
  },
  'a /clear lineage that loops lists no chat': {
    records: [
      chatRecord('chat-alpha', { clearedInto: 'chat-beta' }),
      chatRecord('chat-beta', { clearedInto: 'chat-alpha' })
    ],
    store: { tabs: ['chat-alpha', 'chat-beta'] },
    rows: [],
    chats: []
  },
  'worker identity lost: closed for mail and in the tree': {
    records: [chatRecord('chat-alpha')],
    store: { tabs: ['chat-alpha'] },
    lostWorker: 'chat-alpha',
    rows: [row('chat-alpha', { closed: true, reason: 'unverifiable' })],
    chats: [treeChat('chat-alpha', { closed: true, closedAt: AT })]
  },
  'an old store without a tab API counts every chat as open': {
    records: [chatRecord('chat-alpha')],
    store: { tabApi: 'none' },
    rows: [row('chat-alpha')],
    chats: [treeChat('chat-alpha')]
  },
  'the older tab index: unlisted is closed': {
    records: [chatRecord('chat-alpha')],
    store: { tabApi: 'index', tabs: [] },
    rows: [row('chat-alpha', { closed: true, reason: 'ended' })],
    chats: [treeChat('chat-alpha', { closed: true, closedAt: AT })]
  },
  'the older tab index, unreadable: nothing is proven closed': {
    records: [chatRecord('chat-alpha')],
    store: { tabApi: 'index', tabs: [], indexPresent: false },
    rows: [row('chat-alpha')],
    chats: [treeChat('chat-alpha')]
  },
  'Home and a side chat, newest first': {
    records: [chatRecord('chat-home', { at: AT - 1 }), chatRecord('chat-alpha')],
    store: { tabs: ['chat-home', 'chat-alpha'] },
    rows: [
      row('chat-alpha'),
      row('chat-home', {
        title: 'Chat chat-home',
        lastActivityAt: AT - 1,
        lastAsked: 'Ask in chat-home',
        lastSaid: 'Reply from chat-home',
        home: true
      })
    ],
    chats: [
      treeChat('chat-alpha'),
      treeChat('chat-home', {
        title: 'Home Chat',
        origin: 'home',
        lastActiveAt: AT - 1,
        preview: 'Reply from chat-home'
      })
    ]
  }
}

describe('bot chats: mail refusal and display-closed verdicts', () => {
  it.each(Object.entries(matrix))('%s', async (_name, scenario) => {
    const database = openDb()
    if (scenario.lostWorker) {
      recordLostWorker(database, scenario.lostWorker)
    }
    const store = storeOf(scenario.records, scenario.store)

    const rows = listBotChats(store, database, bot, null, noRuns())
    expect(rows).toEqual(scenario.rows)
    // The public DTO carries no record or session facts; only a closed chat says why, in one word.
    for (const chat of rows) {
      expect(Object.keys(chat).sort()).toEqual(
        [
          'closed',
          'home',
          'id',
          'lastActivityAt',
          'lastAsked',
          'lastSaid',
          'self',
          'title',
          ...(chat.closed ? ['reason'] : [])
        ].sort()
      )
    }

    const tree = await readBotChatTree(treeHost(store, database, scenario.statusRows), {
      botId: bot.id
    })
    const hasHome = scenario.chats.some((chat) => chat.origin === 'home')
    expect(tree.chats).toEqual(hasHome ? scenario.chats : [NO_HOME_YET, ...scenario.chats])
  })

  it('names the asking chat as self', () => {
    const database = openDb()
    const store = storeOf([chatRecord('chat-alpha'), chatRecord('chat-beta')], {
      tabs: ['chat-alpha', 'chat-beta']
    })
    expect(listBotChats(store, database, bot, 'chat-beta', noRuns())).toEqual([
      row('chat-alpha'),
      row('chat-beta', { self: true })
    ])
  })
})

describe('bot chats tree: a chat worker in its own workspace', () => {
  const worktree = 'repo-1::/workspaces/ponyfish'

  /** A side chat's running chat worker in its own workspace, its pane working since after its Dispatch. */
  function chatWorkerTree(otherRows: AgentStatusIpcPayload[] = []) {
    const database = openDb()
    database.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status, creator_orca_session_id, assignee_orca_session_id, created_at)
         VALUES ('ctx-chat-worker', 't-chat-worker', 'dispatched', 'chat-alpha', 'chat-worker', '2023-11-14 22:13:20')`
      )
      .run()
    database.db
      .prepare(
        `INSERT INTO worker_dispatches (dispatch_id, worktree_id) VALUES ('ctx-chat-worker', ?)`
      )
      .run(worktree)
    const store = storeOf([chatRecord('chat-home'), chatRecord('chat-alpha')], {
      tabs: ['chat-home', 'chat-alpha']
    })
    const workerRow = statusRow(structuredAgentSessionStatusPaneKey('chat-worker'), {
      state: 'working',
      worktreeId: worktree,
      stateStartedAt: AT + 60_000
    })
    const host: BotChatTreeHost = {
      ...treeHost(store, database, [workerRow, ...otherRows]),
      handedWorktreeIds: async () => new Set([worktree])
    }
    return readBotChatTree(host, { botId: bot.id })
  }

  it('lists under the side chat that started it, not under Home as handed over', async () => {
    const tree = await chatWorkerTree()

    expect(tree.workspaceChats).toEqual({ [worktree]: 'chat-alpha' })
    const byId = new Map(tree.chats.map((chat) => [chat.chatId, chat]))
    expect(byId.get('chat-home')?.running).toEqual([])
    expect(byId.get('chat-alpha')?.running.map((worker) => worker.key)).toEqual([
      'worker:ctx-chat-worker'
    ])
  })

  it('keeps another agent in that workspace listed as handed over, the workspace with the chat', async () => {
    const other = statusRow('tab-other:leaf-other', {
      state: 'blocked',
      worktreeId: worktree,
      stateStartedAt: AT + 120_000
    })

    const tree = await chatWorkerTree([other])

    expect(tree.workspaceChats).toEqual({ [worktree]: 'chat-alpha' })
    const byId = new Map(tree.chats.map((chat) => [chat.chatId, chat]))
    expect(byId.get('chat-home')?.running.map((worker) => [worker.key, worker.note])).toEqual([
      ['agent:local:tab-other:leaf-other', 'handed-over']
    ])
    expect(byId.get('chat-alpha')?.running.map((worker) => worker.key)).toEqual([
      'worker:ctx-chat-worker'
    ])
  })
})
