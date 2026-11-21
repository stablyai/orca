import { expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { RuntimeOrchestrationSenderNames } from './runtime-orchestration-sender-names'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)

const WORKTREE = 'repo_1::/work/tree'
const CHATS = 1000

type Session = NonNullable<
  ReturnType<
    ConstructorParameters<typeof RuntimeOrchestrationSenderNames>[0]['getWorkspaceSession']
  >
>
type SavedTab = NonNullable<Session['unifiedTabs']>[string][number]

function sessionId(index: number) {
  return testOrcaSessionId(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
}

// Guards #46247: each chat row's name scanned the saved tabs from the start, ~1M row visits per listing at 1,000 chats.
it('names a listing of chat rows visiting each saved tab at most twice', () => {
  const records = new Map<string, AgentSessionRecord>()
  for (let index = 0; index < CHATS; index++) {
    const base = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: sessionId(index) })
    )
    records.set(sessionId(index), {
      ...base,
      location: { ...base.location, workspaceId: WORKTREE }
    })
  }
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
  let visits = 0
  // Every other saved tab is a file, so the count covers rows the lookup skips.
  const saved: SavedTab[] = Array.from({ length: CHATS * 2 }, (_, index) => {
    const isChat = index % 2 === 1
    return {
      entityId: isChat ? sessionId((index - 1) / 2) : `/file-${index}`,
      get contentType() {
        visits++
        return isChat ? ('agent-session' as const) : ('editor' as const)
      },
      label: 'Tab',
      customLabel: index === CHATS * 2 - 1 ? 'Renamed' : null
    }
  })
  const naming = new RuntimeOrchestrationSenderNames({
    getDb: () => null,
    getHandleRecord: () => undefined,
    getPtyAgents: () => undefined,
    getTerminalPaneKey: () => null,
    getWorkspaceSession: (worktreeId) =>
      worktreeId === WORKTREE ? { unifiedTabs: { [WORKTREE]: saved } } : undefined,
    getStore: () => ({ getSettings: () => ({ tabAutoGenerateTitle: false }), getBots: () => [] }),
    getAgentStatusSnapshotForPane: () => [],
    getTrackedTitle: () => null
  })

  const nameRow = naming.agentRowNamer()
  const names = Array.from({ length: CHATS }, (_, index) => {
    const tabId = structuredAgentSessionTabId(sessionId(index))
    return nameRow({ paneKey: `${tabId}:x`, tabId, worktreeId: WORKTREE, agentType: 'claude' })
  })

  expect(names.at(-1)).toBe('Renamed')
  expect(visits).toBe(2002)
})
