// A host for `readBotOwnChatPanes` over in-memory records and a fresh orchestration database.
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { structuredWorkerIdentities } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import type { BotChatTreeHost } from './bot-chat-tree-host'
import { BotLookAroundStore } from './bot-look-around-store'
import { makeTestBot } from './bot.test-fixture'

export const bot = makeTestBot({ folderWorkspaceId: 'home-1', chatSessionId: 'chat-home' })

let db: OrchestrationDb | undefined

export function closeOwnChatHost(): void {
  structuredWorkerIdentities.clear()
  db?.close()
  db = undefined
}

export function homeRecord(
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

export function ownChatHost(
  records: readonly AgentSessionRecord[],
  bots: readonly (typeof bot)[] = [bot],
  tabReads: string[] = []
): BotChatTreeHost & { db: () => OrchestrationDb } {
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
