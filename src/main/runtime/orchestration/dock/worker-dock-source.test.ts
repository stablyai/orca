import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'

const hostRef: { current: unknown } = { current: null }
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrchestrationDb } = await import('../db/orchestration-db')
const { readWorkerDock } = await import('./worker-dock-read')
const { workerDockSourceOfSession, workerDockSourceSessions } = await import('./worker-dock-source')

// A bot's Home Chat started as HOME and was cleared into LIVE, which its tab now shows.
const HOME = testOrcaSessionId('5b2e7d3f-9c4a-4f8b-8d26-1e3c7f9a2b48')
const LIVE = testOrcaSessionId('6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59')
const OTHER = testOrcaSessionId('7d4a9f5b-be6c-4bad-af48-3a5e9b1c4d6a')

function record(sessionId: string, clearedInto?: string): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return clearedInto
    ? {
        ...base,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: clearedInto,
          operationId: `op-${sessionId}`,
          callerKey: 'caller',
          phase: 'committed'
        }
      }
    : base
}

function installRecords(...records: AgentSessionRecord[]): void {
  const bySession = new Map(records.map((entry) => [entry.sessionId, entry]))
  hostRef.current = {
    deps: {
      store: {
        getConversation: (sessionId: string) => {
          const found = bySession.get(sessionId)
          return found ? agentSessionConversationView(found) : null
        },
        listConversations: () => [...bySession.values()].map(agentSessionConversationView),
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [LIVE] })
      }
    }
  }
}

let db: InstanceType<typeof OrchestrationDb>
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  installRecords(record(HOME, LIVE), record(LIVE), record(OTHER))
})
afterEach(() => {
  db.close()
  hostRef.current = null
})

/** `worker-start` from a chat records the chat's /clear root as its creator. */
function workerStartedBy(orcaSessionId: typeof HOME): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Fix the beachball' })
  return db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  }).dispatch.id
}

describe('worker dock source of a cleared chat', () => {
  it('shows the workers its earlier session started in the session its pane shows now', () => {
    const dispatchId = workerStartedBy(HOME)
    const live = readWorkerDock(db, { party: formatOrcaSessionAddress(LIVE), direction: 'around' })
    expect(live.identities.map((row) => row.dispatchId)).toEqual([dispatchId])
    const other = readWorkerDock(db, {
      party: formatOrcaSessionAddress(OTHER),
      direction: 'around'
    })
    expect(other.identities).toEqual([])
  })

  it('reads presence at the root and republishes every session of its lineage', () => {
    expect(workerDockSourceOfSession(LIVE)).toBe(HOME)
    expect(workerDockSourceOfSession(OTHER)).toBe(OTHER)
    expect(workerDockSourceSessions(HOME)).toEqual([HOME, LIVE])
    expect(workerDockSourceSessions(OTHER)).toEqual([OTHER])
  })
})
