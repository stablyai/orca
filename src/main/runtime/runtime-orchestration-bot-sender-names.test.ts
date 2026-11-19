import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { RuntimeOrchestrationSenderNames } from './orchestration/mailbox/senders/runtime-orchestration-sender-names'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const CHAT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const HOME = folderWorkspaceKey('triage-home')

let records: Map<string, AgentSessionRecord>
let bots: { name: string; folderWorkspaceId: string }[]

function names() {
  return new RuntimeOrchestrationSenderNames({
    getDb: () => null,
    getHandleRecord: () => undefined,
    getPtyAgents: () => undefined,
    getTerminalPaneKey: () => null,
    getWorkspaceSession: () => undefined,
    getStore: () => ({
      getSettings: () => ({ tabAutoGenerateTitle: false, botsEnabled: true }),
      getBots: () => bots
    }),
    getAgentStatusSnapshotForPane: () => [],
    getTrackedTitle: () => null
  })
}

beforeEach(() => {
  bots = []
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: CHAT }))
  records = new Map([
    [CHAT, { ...base, conversationName: 'Home', location: { ...base.location, workspaceId: HOME } }]
  ])
  hostRef.current = {
    deps: {
      store: {
        getConversation: (id: string) => {
          const record = records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => []
      }
    }
  }
})

describe("a bot's home names its chats", () => {
  it("names every chat in a bot's home by its bot, never by the chat's own name", () => {
    bots = [{ name: 'Triage bot', folderWorkspaceId: 'triage-home' }]
    expect(names().sender(`orca_session_id:${CHAT}`)).toMatchObject({
      name: 'Triage bot',
      bot: true
    })
    const tabId = structuredAgentSessionTabId(CHAT)
    const row = { paneKey: `${tabId}:x`, tabId, worktreeId: HOME, agentType: 'claude' as const }
    expect(names().agentRowNamer()(row)).toBe('Triage bot')
    bots = []
    expect(names().sender(`orca_session_id:${CHAT}`)).not.toHaveProperty('bot')
    expect(names().sender(`orca_session_id:${CHAT}`).name).toBe('Home')
  })
})
