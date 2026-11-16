import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
// Open Dispatches retain active work; chats at rest remain mail recipients until tab retirement. Process liveness and close proof remain separate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const { observeStructuredWorker, resolveStructuredWorkerAuthority } =
  await import('./structured-worker-authority')
const { structuredWorkerOwesWork } = await import('./structured-worker-custody')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')
const { listAddressableStructuredWorkers } =
  await import('../../addressing/groups/structured-worker-group-addressing')
await import('../../../agent-session/structured-agent-session-close')
const { resolveGroupAddress } = await import('../../addressing/groups/group-addressing')
const { createRestTestRig, foundRestTestChat, sweepTicks } =
  await import('../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture')
const { STRUCTURED_AGENT_SESSION_IDLE_MS: IDLE_MS } =
  await import('../../../../native-chat/agent-session-wire/termination/structured-agent-session-idle-sweep')
const { HOST_TEST_SESSION: REST_TEST_SESSION } =
  await import('../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture')

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })

function record(lease: Partial<AgentSessionRecord['lease']>): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: SESSION, runtimeFence: 3, ...lease })
  )
  return {
    ...base,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
    providerHandleChain: base.providerHandleChain.map((link) => ({
      ...link,
      handle: codexProviderHandle('at-rest')
    })),
    location: { ...base.location, workspaceId: 'wt_1' }
  }
}

function installHost(current: AgentSessionRecord | null, tabs: string[]) {
  const host = {
    deps: {
      logger: { warn: vi.fn() },
      store: {
        getRecord: () => current,
        getConversation: () => (current ? agentSessionConversationView(current) : null),
        listConversations: () => (current ? [agentSessionConversationView(current)] : []),
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: tabs })
      }
    },
    getSessionTabId: (id: string) => (tabs.includes(id) ? `agent-session:${id}` : null),
    hasSession: () => false,
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: tabs }),
    setSessionTabVisibility: vi.fn(async (_id: string, visible: boolean) => {
      tabs.splice(0, tabs.length, ...(visible ? [SESSION] : []))
    }),
    close: vi.fn(async () => undefined)
  }
  hostRef.current = host
  return host
}

beforeEach(() => {
  structuredWorkerIdentities.clear()
  hostRef.current = null
})

describe('an open dispatch keeps its worker running (P2-19 i)', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function dispatchWorker(hostScope = LOCAL) {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'structured work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
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
      hostScope,
      terminalOwnership: 'created'
    })
    return dispatch
  }

  it('keeps a worker at rest after its dispatch settles a group recipient, until its tab goes (P2-19 ii)', () => {
    const dispatch = dispatchWorker()
    db.markWorkerDispatchReady(dispatch.id)
    db.beginWorkerStop(dispatch.id, 'epoch_home')
    db.settleWorkerStop(dispatch.id)
    // Settlement forgets the in-memory entry; only the durable row and the record remain.
    structuredWorkerIdentities.clear()
    const tabs = [SESSION]
    installHost(
      record({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'stopped by the sweep', observedAt: 1 }
      }),
      tabs
    )
    const handle = db.getWorkerTerminalResourceByOwner(dispatch.id)!.terminal_handle
    const recipients = () => listAddressableStructuredWorkers(db)

    expect(recipients()).toEqual([{ handle, worktreeId: 'wt_1', agentIdentity: 'codex' }])
    expect(resolveGroupAddress('@codex', 'term_sender', recipients(), () => 'idle')).toEqual([
      handle
    ])
    expect(resolveGroupAddress('@claude', 'term_sender', recipients(), () => 'idle')).toEqual([])
    // Direct mail resolves the same worker through the same ownership answer.
    expect(resolveStructuredWorkerAuthority(handle, db)?.identity.handle).toBe(handle)

    tabs.length = 0
    expect(recipients()).toEqual([])
    expect(resolveStructuredWorkerAuthority(handle, db)).toBeNull()
  })

  it('stops routing to a worker its coordinator abandoned and then released, and keeps its tab', () => {
    const dispatch = dispatchWorker()
    db.markWorkerDispatchReady(dispatch.id)
    structuredWorkerIdentities.clear()
    const tabs = [SESSION]
    installHost(
      record({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'stopped by the sweep', observedAt: 1 }
      }),
      tabs
    )
    const resource = db.getWorkerTerminalResourceByOwner(dispatch.id)!
    const handle = resource.terminal_handle
    const recipients = () => listAddressableStructuredWorkers(db)
    // At rest, its dispatch abandoned: still a recipient, as a terminal worker left running is.
    db.abandonWorkerDispatch(dispatch.id, 'epoch_test')
    const worktreeGroup = () =>
      resolveGroupAddress('@worktree:wt_1', 'term_sender', recipients(), () => 'idle')
    expect(worktreeGroup()).toEqual([handle])
    expect(resolveStructuredWorkerAuthority(handle, db)).not.toBeNull()

    // The release finds the agent at rest, so it settles as released.
    expect(db.requestWorkerTerminalRelease(dispatch.id)).toMatchObject({ disposition: 'retained' })
    expect(
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: dispatch.id,
        resourceId: resource.id,
        processIncarnation: resource.process_incarnation!
      })
    ).toMatchObject({ disposition: 'released' })

    expect(tabs).toEqual([SESSION])
    expect(worktreeGroup()).toEqual([])
    // Direct mail routes through the same answer.
    expect(resolveStructuredWorkerAuthority(handle, db)).toBeNull()
  })
})

describe('a task dispatched into a worker whose own dispatch settled', () => {
  it('keeps the worker running while that task is open, and lets it rest once the task settles', async () => {
    const db = new OrchestrationDb(':memory:')
    const rig = await createRestTestRig({
      hasOpenDispatch: (current) => structuredWorkerOwesWork(db, current)
    })
    try {
      hostRef.current = rig.host
      await foundRestTestChat(rig)
      const incarnation = structuredWorkerProcessIncarnation(REST_TEST_SESSION)
      const handle = mintStructuredWorkerHandle()
      const workerPane = mintStructuredWorkerPaneKey(REST_TEST_SESSION)
      const first = db.createTask({ runId: 'run_legacy_local', spec: 'first task' })
      const { dispatch: started } = db.createStartingWorkerDispatch({
        taskId: first.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 9
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.id,
        handle,
        paneKey: workerPane,
        processIncarnation: incarnation,
        worktreeId: 'wt_1',
        effects: [],
        setupState: 'not_configured',
        hostScope: LOCAL,
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.id)
      expect(
        db.settleWorkerReport({
          taskId: first.id,
          dispatchId: started.id,
          outcome: 'succeeded',
          result: 'done'
        })
      ).toMatchObject({ action: 'settled' })
      // The coordinator hands the same worker its next task: a dispatch with no worker row.
      const second = db.createTask({ runId: 'run_legacy_local', spec: 'second task' })
      const handedOn = db.createDispatchContext({
        taskId: second.id,
        assigneeHandle: handle,
        assigneePaneKey: workerPane,
        processIncarnation: incarnation,
        creator: { kind: 'system' },
        maxDepth: 9
      })
      rig.clock.now += 2 * IDLE_MS

      await sweepTicks(12)
      expect(rig.adapter.closeSession).not.toHaveBeenCalled()
      expect(observeStructuredWorker({ sessionId: REST_TEST_SESSION }).status).toBe('live')

      db.completeDispatch(handedOn.id)
      rig.clock.now += IDLE_MS + 1
      await vi.waitFor(() =>
        expect(observeStructuredWorker({ sessionId: REST_TEST_SESSION }).status).toBe('exited')
      )
      expect(rig.adapter.closeSession).toHaveBeenCalledWith(REST_TEST_SESSION, undefined)
    } finally {
      hostRef.current = null
      await rig.dispose()
      db.close()
    }
  })
})
