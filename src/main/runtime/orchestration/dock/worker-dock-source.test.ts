import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { createAgentStatusStore } from '../../../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'

const hostRef: { current: unknown } = { current: null }
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrchestrationDb } = await import('../db/orchestration-db')
const { readWorkerDock, acknowledgeWorkerDock } = await import('./worker-dock-read')
const { workerDockFailureSink } = await import('./worker-dock-provider-failures')
const { workerDockSourceOfSession, workerDockSourceSessions } = await import('./worker-dock-source')
const { subscribeWorkerDock } = await import('./worker-dock-stream')
const { workerDockActivitySource } = await import('./worker-dock-activity')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} = await import('../terminal-authority/structured-sessions/structured-worker-identity')

// A bot's Home Chat started as HOME and was cleared into LIVE, which its tab now shows.
const HOME = testOrcaSessionId('5b2e7d3f-9c4a-4f8b-8d26-1e3c7f9a2b48')
const LIVE = testOrcaSessionId('6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59')
const OTHER = testOrcaSessionId('7d4a9f5b-be6c-4bad-af48-3a5e9b1c4d6a')
const WORKER = testOrcaSessionId('8e5bad6c-cf7d-4cbe-b059-4b6fac2d5e7b')

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
    },
    hasSession: (sessionId: string) => bySession.has(sessionId)
  }
}

let db: InstanceType<typeof OrchestrationDb>
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  installRecords(record(HOME, LIVE), record(LIVE), record(OTHER), record(WORKER))
})
afterEach(() => {
  db.close()
  hostRef.current = null
  vi.useRealTimers()
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

  it('keeps a provider failure from after /clear in the root chat dock until its Clear', () => {
    // The live session of the lineage reports the failure; the dock reads the /clear root.
    const parent = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: '/folder',
        workspaceKind: 'folder'
      },
      LIVE
    )
    const store = createAgentStatusStore({ epoch: 'lineage-failure', mode: 'authority' })
    store.applyMutation({ parent: { subject: parent } })
    const admission = createAgentChildWorkAdmission(store, { mintChildWorkId: () => 'child-1' })
    const sink = workerDockFailureSink(
      {
        publish: () => {},
        forget: () => {},
        publishChildWork: (_subject, evidence, provider) =>
          reconcileAgentChildWorkEvidence({ store, admission, parent, evidence, provider })
      },
      { getOrchestrationDb: () => db }
    )!
    const handle = { idKind: 'task_id', id: 'shell-7', runId: 'first' } as const
    sink.publishChildWork!(
      parent,
      [
        {
          type: 'live',
          restart: true,
          observedAt: 100,
          child: {
            handle,
            kind: 'command',
            residency: 'background',
            state: 'working',
            description: 'Verify the journal',
            stoppable: true
          }
        },
        { type: 'ended', observedAt: 200, handle, outcome: 'failed', lastMessage: 'Exit 1.' }
      ],
      'claude'
    )
    for (const session of [HOME, LIVE]) {
      const dock = readWorkerDock(db, {
        party: formatOrcaSessionAddress(session),
        direction: 'around'
      })
      expect(dock.rows).toMatchObject([{ state: 'failed', source: HOME }])
    }
    const [failure] = readWorkerDock(db, {
      party: formatOrcaSessionAddress(LIVE),
      direction: 'around'
    }).rows
    acknowledgeWorkerDock(db, {
      party: formatOrcaSessionAddress(LIVE),
      acknowledged: true,
      settlements: [{ dispatchId: failure.dispatchId, settlement: failure.settlement! }]
    })
    expect(
      readWorkerDock(db, { party: formatOrcaSessionAddress(HOME), direction: 'around' }).identities
    ).toEqual([])
  })

  it("wakes the dock when a structured worker's session status changes at its derived pane", async () => {
    vi.useFakeTimers({ now: 1794657600000, toFake: ['Date'] })
    const dispatchId = workerStartedBy(HOME)
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
      .run(dispatchId)
    // Dispatch authority records the worker's minted pane; its status rows live at the session's own.
    const minted = mintStructuredWorkerPaneKey(WORKER)
    const derived = structuredAgentSessionPaneKey(structuredAgentSessionTabId(WORKER), WORKER)
    expect(minted).not.toBe(derived)
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ? WHERE id = ?'
      )
      .run(
        mintStructuredWorkerHandle(),
        minted,
        structuredWorkerProcessIncarnation(WORKER),
        dispatchId
      )
    let status: AgentStatusIpcPayload = {
      paneKey: derived,
      state: 'working',
      prompt: 'Fix the beachball',
      connectionId: null,
      receivedAt: 1794657600000,
      stateStartedAt: 100,
      structuredHost: 'owned'
    }
    let changed: ((pane: string) => void) | undefined
    const source = workerDockActivitySource(db, formatOrcaSessionAddress(LIVE), {
      readAgentStatusOfPanes: (panes) => (panes.includes(status.paneKey) ? [status] : []),
      readObservedAgentStatusPaneIdentityFn: () => ({ kind: 'unobserved' }),
      getAgentStatusTerminalHandleForPaneKey: () => undefined,
      getTerminalProcessIncarnation: () => null,
      subscribeAgentStatusRowChanges: (listener) => {
        changed = listener
        return () => {}
      }
    })
    const states: string[] = []
    const stop = subscribeWorkerDock(
      db,
      formatOrcaSessionAddress(LIVE),
      (value) => states.push(value.rows[0]?.state ?? ''),
      source
    )
    expect(states).toEqual(['running'])
    status = { ...status, state: 'done', stateStartedAt: 200, receivedAt: 1794657601000 }
    changed!(derived)
    await vi.waitFor(() => expect(states.at(-1)).toBe('idle'))
    stop()
  })
})
