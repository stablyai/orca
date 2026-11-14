// A worker Orca started in a chat ends with its chat, as a terminal worker ends with its terminal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { OrchestrationDb } from '../../db/orchestration-db'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import '../../db/contract-constants'
import '../../db/dispatch-row-writer'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const { OrcaRuntimeService } = await import('../../../orca-runtime')
const { stopReportId } = await import('../../workers/turn-stops/worker-turn-stop-report')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })

/** A host whose one chat is open and attached until `close` marks its process gone. */
function installHost() {
  let attached = true
  const current = () =>
    agentSessionConversationView(
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: SESSION,
          runtimeFence: 3,
          claimStatus: attached ? 'live' : 'released',
          deathEvidence: attached
            ? null
            : { kind: 'exit-observed', detail: 'closed by Orca', observedAt: 1 }
        })
      )
    )
  hostRef.current = {
    deps: {
      logger: { warn: vi.fn() },
      store: {
        getRecord: () => current(),
        getConversation: () => current(),
        listConversations: () => [current()],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
      }
    },
    getSessionTabId: () => null,
    hasSession: () => attached
  }
  return {
    close: () => {
      attached = false
    }
  }
}

let db: OrchestrationDb
let runtime: InstanceType<typeof OrcaRuntimeService>

beforeEach(() => {
  structuredWorkerIdentities.clear()
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService(partialRuntimeStore())
  runtime.setOrchestrationDb(db)
})

afterEach(() => {
  hostRef.current = null
  structuredWorkerIdentities.clear()
  db.close()
})

function startChatWorker() {
  const run = db.createRun({
    objective: 'review',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'review the change' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'terminal', handle: 'term_coordinator' },
    maxDepth: 9
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: mintStructuredWorkerHandle(),
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    worktreeId: 'wt_1',
    effects: [],
    setupState: 'not_configured',
    hostScope: LOCAL,
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  return { taskId: task.id, dispatchId: dispatch.id }
}

function lostReports(dispatchId: string): number {
  return db.getMessageById(stopReportId(dispatchId, 'gone')) ? 1 : 0
}

describe('a worker Orca started in a chat', () => {
  it('fails its Dispatch and tells the coordinator once when its chat is closed, as when its workspace is removed', () => {
    const chat = installHost()
    const { taskId, dispatchId } = startChatWorker()

    chat.close()
    runtime.onStructuredSessionTabHidden(SESSION)
    runtime.onStructuredSessionTabHidden(SESSION)

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'operator_close'
    })
    expect(db.getTask(taskId)?.status).not.toBe('dispatched')
    expect(lostReports(dispatchId)).toBe(1)
    expect(db.getMessageById(stopReportId(dispatchId, 'gone'))?.subject).toBe(
      'Worker lost without reporting'
    )
  })

  it('keeps its Dispatch while its chat still runs', () => {
    installHost()
    const { dispatchId } = startChatWorker()

    runtime.onStructuredSessionTabHidden(SESSION)

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(lostReports(dispatchId)).toBe(0)
  })

  it("settles the coordinator's own stop without an alert", () => {
    const chat = installHost()
    const { dispatchId } = startChatWorker()
    db.beginWorkerStop(dispatchId, runtime.getRuntimeId())

    chat.close()
    runtime.onStructuredSessionTabHidden(SESSION)

    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(lostReports(dispatchId)).toBe(0)
  })
})
