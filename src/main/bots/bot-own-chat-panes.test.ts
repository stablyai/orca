import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import type { BotChatTreeHost } from './bot-chat-tree-host'
import { BotLookAroundStore } from './bot-look-around-store'
import { readBotOwnChatPanes } from './bot-own-chat-panes'
import { makeTestBot } from './bot.test-fixture'

const bot = makeTestBot({ folderWorkspaceId: 'home-1', chatSessionId: 'chat-home' })

let db: OrchestrationDb | undefined
afterEach(() => {
  structuredWorkerIdentities.clear()
  db?.close()
  db = undefined
})

function homeRecord(
  sessionId: string,
  name: string,
  home = bot.folderWorkspaceId
): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return {
    ...base,
    location: { ...base.location, workspaceId: folderWorkspaceKey(home) },
    conversationName: name,
    lastTurn: { state: 'settled', at: 1, prompt: 'ask', reply: 'reply' }
  }
}

function host(
  records: readonly AgentSessionRecord[],
  bots: readonly (typeof bot)[] = [bot],
  tabReads: string[] = []
): BotChatTreeHost {
  const views = new Map(records.map((r) => [r.sessionId, agentSessionConversationView(r)]))
  const store: AgentSessionRecordReader = {
    getRecord: (sessionId) => views.get(sessionId) ?? null,
    listRecords: () => [...views.values()],
    isSessionTabRetired: () => false
  }
  db = new OrchestrationDb(':memory:')
  const database = db
  return {
    bots: () => bots,
    externalConversations: () => [],
    chatTabs: async (workspaceId) => {
      tabReads.push(workspaceId)
      return []
    },
    statusRows: () => [],
    automations: () => [],
    automationRuns: () => new Map(),
    recordedWorkers: async () => [],
    sessionRecords: async () => store,
    db: () => database,
    dispatchWorkers: async () => [],
    backgroundRuns: new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  }
}

describe('readBotOwnChatPanes', () => {
  it('lists the bot’s side chats and leaves out a Dispatch worker running in its home', async () => {
    const side = homeRecord('chat-side', 'Plan the launch')
    const worker = homeRecord('chat-worker', 'Fix the build')
    structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: worker.sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(worker.sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(worker.sessionId),
      worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const chats = await readBotOwnChatPanes(host([side, worker]))
    expect(chats[bot.id]?.map((chat) => chat.title)).toEqual(['Plan the launch'])
  })

  it.each([10, 100])('reads only the bots named, of %i bots', async (botCount) => {
    const bots = Array.from({ length: botCount }, (_, i) =>
      makeTestBot({
        id: `bot-${i}`,
        folderWorkspaceId: `home-${i}`,
        chatSessionId: `home-chat-${i}`
      })
    )
    const records = bots.map((each, i) =>
      homeRecord(`chat-side-${i}`, `Side ${i}`, each.folderWorkspaceId)
    )
    const tabReads: string[] = []
    const read = host(records, bots, tabReads)
    const named = await readBotOwnChatPanes(read, ['bot-3'])
    expect(Object.keys(named)).toEqual(['bot-3'])
    expect(named['bot-3']?.map((chat) => chat.title)).toEqual(['Side 3'])
    expect(tabReads).toHaveLength(1)
    // Without names, every bot is answered, as before.
    tabReads.splice(0)
    const all = await readBotOwnChatPanes(read)
    expect(Object.keys(all)).toHaveLength(botCount)
    expect(tabReads).toHaveLength(botCount)
  })
})
