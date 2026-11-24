// A closed chat tab settles the workers it ran; an admitted bot chat end skips that search entirely,
// and neither touches an unrelated worker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostTestState } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import '../../runtime/orchestration/db/contract-constants'
import '../../runtime/orchestration/db/messages/mailbox-routing-page'
import '../../runtime/orchestration/db/dispatch-row-writer'
import '../../runtime/orchestration/db/attempt-outcome-projection'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { fenceChatEnd, resetChatEndFencesForTests } from './bot-chat-end-fence'

const CLOSED = 'session-closed-chat'
const UNRELATED = 'session-unrelated-chat'
const WORKTREE = 'repo::worktree'

let db: OrchestrationDb
let runtime: OrcaRuntimeService

function startWorker(sessionId: string, handle: string): string {
  const paneKey = mintStructuredWorkerPaneKey(sessionId)
  const processIncarnation = structuredWorkerProcessIncarnation(sessionId)
  structuredWorkerIdentities.register({
    handle,
    sessionId,
    agent: 'claude',
    paneKey,
    processIncarnation,
    worktreeId: WORKTREE,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const task = db.createTask({ runId: 'run_legacy_local', spec: `work in ${sessionId}` })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {},
    runtimeEpoch: runtime.getRuntimeId()
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation,
    worktreeId: WORKTREE,
    setupState: 'not_applicable',
    effects: [{ kind: 'terminal', action: 'created', id: handle }],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return started.dispatch.id
}

beforeEach(() => {
  resetChatEndFencesForTests()
  structuredWorkerIdentities.clear()
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  // CLOSED's agent has exited (its tab just closed); UNRELATED's is still running.
  const { host, store } = hostTestState()
  vi.spyOn(host, 'hasSession').mockImplementation((id) => id === UNRELATED)
  vi.spyOn(store, 'getConversation').mockImplementation((id) => {
    const exited = id === CLOSED
    return agentSessionConversationView(
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: id,
          claimStatus: exited ? 'released' : 'live',
          deathEvidence: exited
            ? { kind: 'exit-observed', detail: 'closed by Orca', observedAt: 1 }
            : null
        })
      )
    )
  })
  setStructuredAgentSessionHost(host)
})

afterEach(() => {
  db.close()
  structuredWorkerIdentities.clear()
  setStructuredAgentSessionHost(null)
  resetChatEndFencesForTests()
  vi.restoreAllMocks()
})

describe('closing a chat tab', () => {
  it('settles the workers its chat ran, and leaves an unrelated worker running', () => {
    const closed = startWorker(CLOSED, 'structworker_11111111-1111-4111-a111-111111111111')
    const unrelated = startWorker(UNRELATED, 'structworker_33333333-3333-4333-a333-333333333333')
    const ready = db.getWorkerDispatch(unrelated)?.state

    runtime.onStructuredSessionTabHidden(CLOSED)

    expect(db.getWorkerDispatch(closed)?.state).not.toBe(ready)
    expect(db.getWorkerDispatch(unrelated)?.state).toBe(ready)
  })

  it('never searches for workers to settle while its bot chat end is admitted', () => {
    const closed = startWorker(CLOSED, 'structworker_11111111-1111-4111-a111-111111111111')
    const unrelated = startWorker(UNRELATED, 'structworker_33333333-3333-4333-a333-333333333333')
    const ready = db.getWorkerDispatch(closed)?.state
    const prepare = vi.spyOn(db.db, 'prepare')
    fenceChatEnd([CLOSED])

    runtime.onStructuredSessionTabHidden(CLOSED)

    expect(prepare).not.toHaveBeenCalled()
    expect(db.getWorkerDispatch(closed)?.state).toBe(ready)
    expect(db.getWorkerDispatch(unrelated)?.state).toBe(ready)
  })
})
