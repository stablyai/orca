// A structured worker whose agent is at rest: its dispatch keeps it running while open, and once it
// rests it is still this runtime's worker — mail reaches it — until its chat tab is gone. Whether
// its process runs is a separate answer, and a close counts a released lease as done.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { OrchestrationDb } from './orchestration/db'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const {
  observeStructuredWorker,
  resolveStructuredWorkerAuthority,
  structuredSessionCloseSettled,
  structuredWorkerOwned
} = await import('./structured-worker-authority')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerHasOpenDispatch,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')
const { listAddressableStructuredWorkers } =
  await import('./orchestration/structured-worker-group-addressing')
const { closeStructuredAgentSessionChild } = await import('./structured-agent-session-close')
const { resolveGroupAddress } = await import('./orchestration/groups')
const { createRestTestRig, foundRestTestChat, IDLE_MS, REST_TEST_SESSION, sweepTicks } =
  await import('../native-chat/agent-session-wire/structured-agent-session-rest-test-rig')

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })

function record(lease: Partial<AgentSessionRecord['lease']>): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial record; the ownership and liveness reads touch only lease, location and provider.
  return {
    sessionId: SESSION,
    provider: 'codex',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'wt_1',
      workspaceKind: 'git-worktree'
    },
    lease: { claimStatus: 'live', deathEvidence: null, runtimeFence: 3, ...lease }
  } as AgentSessionRecord
}

function installHost(current: AgentSessionRecord | null, tabs: string[]) {
  const host = {
    deps: { store: { getRecord: () => current } },
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

let paneKey = ''

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  paneKey = mintStructuredWorkerPaneKey(SESSION)
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION,
    agent: 'codex',
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
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

  it('answers open while the dispatch starts, runs or stops, and closed once it settles', () => {
    const dispatch = dispatchWorker()
    expect(structuredWorkerHasOpenDispatch(db, record({}))).toBe(true)
    db.markWorkerDispatchReady(dispatch.id)
    expect(structuredWorkerHasOpenDispatch(db, record({}))).toBe(true)
    db.beginWorkerStop(dispatch.id, 'epoch_home')
    expect(structuredWorkerHasOpenDispatch(db, record({}))).toBe(true)
    db.settleWorkerStop(dispatch.id)
    expect(structuredWorkerHasOpenDispatch(db, record({}))).toBe(false)
  })

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
    db.abandonWorkerDispatch(dispatch.id)
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

  it('reads only this host scope, and no database answers no', () => {
    dispatchWorker(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }))
    expect(structuredWorkerHasOpenDispatch(db, record({}))).toBe(false)
    expect(structuredWorkerHasOpenDispatch(null, record({}))).toBe(false)
  })
})

describe('ownership, not liveness (P2-19 ii-iv, P2-26)', () => {
  it('owns a worker at rest while its tab is listed, and routes mail to it', () => {
    const handle = registerWorker()
    installHost(
      record({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'stopped', observedAt: 1 }
      }),
      [SESSION]
    )

    expect(structuredWorkerOwned(SESSION)).toBe(true)
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('exited')
    expect(resolveStructuredWorkerAuthority(handle, null)?.identity.paneKey).toBe(paneKey)
  })

  it('retires a released worker whose tab is gone', () => {
    const handle = registerWorker()
    installHost(record({ claimStatus: 'released' }), [])

    expect(structuredWorkerOwned(SESSION)).toBe(false)
    expect(resolveStructuredWorkerAuthority(handle, null)).toBeNull()
  })

  it('keeps authority for a live session that has no tab', () => {
    const handle = registerWorker()
    installHost(record({ claimStatus: 'live' }), [])

    expect(structuredWorkerOwned(SESSION)).toBe(true)
    expect(resolveStructuredWorkerAuthority(handle, null)).not.toBeNull()
  })

  it('cannot answer without a host', () => {
    expect(structuredWorkerOwned(SESSION)).toBeNull()
  })
})

describe('a close whose stop could not be proven (P2-30)', () => {
  it('closes on the first attempt, keeps the tab retired and leaves the verdict alone', async () => {
    const released = record({ claimStatus: 'released', deathEvidence: null })
    const tabs = [SESSION]
    const host = installHost(released, tabs)
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('unverifiable')

    const outcome = await closeStructuredAgentSessionChild(SESSION)
    expect(outcome).toMatchObject({ stopped: true, closeAttempted: true })
    expect(host.close).toHaveBeenCalledOnce()
    expect(tabs).toEqual([])
    expect(host.setSessionTabVisibility).not.toHaveBeenCalledWith(SESSION, true)
    expect(released.lease.deathEvidence).toBeNull()
    expect(structuredSessionCloseSettled(SESSION)).toBe(true)
  })

  it('still refuses a close that left the lease live', () => {
    installHost(record({ claimStatus: 'live' }), [SESSION])
    expect(structuredSessionCloseSettled(SESSION)).toBe(false)
  })
})

describe('a task dispatched into a worker whose own dispatch settled', () => {
  it('keeps the worker running while that task is open, and lets it rest once the task settles', async () => {
    const db = new OrchestrationDb(':memory:')
    const rig = await createRestTestRig({
      hasOpenDispatch: (current) => structuredWorkerHasOpenDispatch(db, current)
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
      await vi.waitFor(() =>
        expect(observeStructuredWorker({ sessionId: REST_TEST_SESSION }).status).toBe('exited')
      )
      expect(rig.adapter.closeSession).toHaveBeenCalledWith(REST_TEST_SESSION)
    } finally {
      hostRef.current = null
      await rig.dispose()
      db.close()
    }
  })
})
