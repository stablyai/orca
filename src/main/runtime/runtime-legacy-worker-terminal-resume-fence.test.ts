import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type { RuntimeStore } from './runtime-store-contract'

const PANE_KEY = 'tab_worker:33333333-3333-4333-8333-333333333333'
const WORKTREE_ID = 'repo::worktree'

function sessionWithSleepingWorker(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab_worker',
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'codex-session-1' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  } as WorkspaceSessionState
}

describe('settled worker automatic-resume fence persistence', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function harness(
    onFenceChanged?: (paneKey: string, blocked: boolean) => void,
    /** False models a worker that settles while its tab is still open: no record to stamp yet. */
    withSleepingRecord = true
  ): {
    db: OrchestrationDb
    taskId: string
    dispatchId: string
    persistence: RuntimeLegacyWorkerTerminalRecoveryPersistence
    fence: () => string | undefined
  } {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    let session = withSleepingRecord
      ? sessionWithSleepingWorker()
      : (getDefaultWorkspaceSession() as WorkspaceSessionState)
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    const task = orchestrationDb.createTask({ spec: 'fence me' })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    return {
      db: orchestrationDb,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      persistence: new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => store,
        () => orchestrationDb,
        () => LOCAL_EXECUTION_HOST_ID,
        onFenceChanged
      ),
      fence: () => session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy
    }
  }

  function settle(d: OrchestrationDb, taskId: string, dispatchId: string): void {
    expect(
      d.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' }).action
    ).toBe('settled')
  }

  it('pushes the fence to the live renderer instead of waiting for the next app start', () => {
    const fenceChanges: [string, boolean][] = []
    const h = harness((paneKey, blocked) => fenceChanges.push([paneKey, blocked]))
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()

    expect(fenceChanges).toEqual([[PANE_KEY, true]])
  })

  it('announces the fence for a pane that has no sleeping record to stamp yet', () => {
    const fenceChanges: [string, boolean][] = []
    const h = harness((paneKey, blocked) => fenceChanges.push([paneKey, blocked]), false)
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()
    expect(fenceChanges).toEqual([[PANE_KEY, true]])

    const requested = h.db.requestWorkerTerminalRelease(h.dispatchId)
    h.db.settleWorkerTerminalRelease((requested as { resource: { id: string } }).resource.id)
    h.persistence.prepare()

    // A fence the plan no longer claims must be lifted even with no record to read it from.
    expect(fenceChanges).toEqual([
      [PANE_KEY, true],
      [PANE_KEY, false]
    ])
  })

  // The STA-4577 repro: worker_done, no release, restart, open the worktree — the pane still
  // holds a resumable provider session and must not respawn `codex resume`.
  it('fences a settled worker pane whose terminal was never released', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()

    expect(h.fence()).toBe('legacy-orchestration-worker')
  })

  it('lifts the fence once release retires the terminal resource', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fence()).toBe('legacy-orchestration-worker')

    const requested = h.db.requestWorkerTerminalRelease(h.dispatchId)
    expect(requested.disposition).toBe('requested')
    h.db.settleWorkerTerminalRelease((requested as { resource: { id: string } }).resource.id)
    h.persistence.prepare()

    expect(h.fence()).toBeUndefined()
  })

  it('lifts the fence when the user takes the pane over', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fence()).toBe('legacy-orchestration-worker')

    expect(h.db.markWorkerTerminalUserOwned(PANE_KEY)).toBe(1)
    h.persistence.prepare()

    expect(h.fence()).toBeUndefined()
  })

  // An unreadable plan is not evidence a pane stopped needing its fence.
  it('keeps the fence when the recovery plan cannot be read', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fence()).toBe('legacy-orchestration-worker')

    vi.spyOn(h.db, 'listLegacyWorkerTerminalRecoveryRows').mockImplementation(() => {
      throw new Error('orchestration_db_unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(h.persistence.prepare()).toEqual({
        blockedPanes: [],
        candidates: [],
        ambiguousDispatchIds: []
      })
    } finally {
      warn.mockRestore()
    }

    expect(h.fence()).toBe('legacy-orchestration-worker')
  })

  // A live worker's pane was already fenced while main reconciles it against PTY inventory; the
  // settled arm must not disturb that, and the plan must still name it as unsettled.
  it('keeps a live worker pane fenced and marked unsettled', () => {
    const h = harness()

    const plan = h.persistence.prepare()

    expect(h.fence()).toBe('legacy-orchestration-worker')
    expect(plan.blockedPanes).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, settled: false })
    ])
    expect(plan.candidates).toEqual([expect.objectContaining({ dispatchId: h.dispatchId })])
  })
})

// STA-4577's other half: settlement with no release and no restart. The stamp only ran at startup
// and after release/retain/takeover, so reopening the pane in the same session respawned the agent.
describe('worker_done without a release', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('fences the pane in the same session', async () => {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    let session = sessionWithSleepingWorker()
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(orchestrationDb)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? PANE_KEY : 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    const run = orchestrationDb.createRun({
      objective: 'settle without release',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = orchestrationDb.createTask({ spec: 'settle without release', runId: run.id })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    const capability = orchestrationDb.mintDispatchCapability({
      dispatchId: started.dispatch.id,
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1'
    })
    expect(session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy).toBe(
      undefined
    )

    const send = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.send')!
    await send.handler(
      send.params!.parse({
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: started.dispatch.id,
          outcome: 'succeeded'
        })
      }),
      { runtime, orchestrationCapability: capability }
    )

    expect(orchestrationDb.getWorkerDispatch(started.dispatch.id)?.state).toBe('succeeded')
    expect(session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy).toBe(
      'legacy-orchestration-worker'
    )
  })
})
