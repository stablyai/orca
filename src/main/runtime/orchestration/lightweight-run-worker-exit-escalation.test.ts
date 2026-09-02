import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { DISPATCH_CIRCUIT_BREAK_FAILURES } from './db/dispatch-context/dispatch-circuit-breaker'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

// STA-4604: failActiveDispatchOnExit fails the dispatch on worker PTY exit but used to
// gate the "Agent exited unexpectedly" escalation on the legacy coordinator_runs table.
// A lightweight Run (runs + run_coordinator_handles) never populates that table, so
// worker death was silent for its coordinator. The escalation now follows the dispatch's
// own Run to the mailbox `orchestration check` actually reads.

const WORKTREE_ID = 'repo-1::/tmp/sta-4604-worktree'
const WORKER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const COORDINATOR_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WORKER_PTY_ID = 'pty-worker'
const COORDINATOR_PTY_ID = 'pty-coordinator'
const WORKER_PANE_KEY = makePaneKey('tab-worker', WORKER_LEAF_ID)
const COORDINATOR_PANE_KEY = makePaneKey('tab-coordinator', COORDINATOR_LEAF_ID)

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/sta-4604-worktree',
        displayName: 'sta-4604',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithTwoPanes(): {
  runtime: OrcaRuntimeService
  workerHandle: string
  coordinatorHandle: string
} {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: vi.fn(() => true),
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  } as never)
  const workerHandle = runtime.preAllocateHandleForPty(WORKER_PTY_ID)
  const coordinatorHandle = runtime.preAllocateHandleForPty(COORDINATOR_PTY_ID)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        title: 'Worker',
        activeLeafId: WORKER_LEAF_ID,
        layout: null
      },
      {
        tabId: 'tab-coordinator',
        worktreeId: WORKTREE_ID,
        title: 'Coordinator',
        activeLeafId: COORDINATOR_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        leafId: WORKER_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: WORKER_PTY_ID,
        paneTitle: null
      },
      {
        tabId: 'tab-coordinator',
        worktreeId: WORKTREE_ID,
        leafId: COORDINATOR_LEAF_ID,
        paneRuntimeId: 2,
        ptyId: COORDINATOR_PTY_ID,
        paneTitle: null
      }
    ]
  })
  return { runtime, workerHandle, coordinatorHandle }
}

// Pointer delivery runs on a microtask; let it settle before the DB closes.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The single oracle every mode is graded by: after a worker PTY exit, is the dispatch
// failed, and did the escalation reach a mailbox this coordinator actually reads?
async function gradeWorkerExit(
  mode: 'lightweight-run' | 'legacy-run' | 'legacy-run-no-coordinator'
): Promise<{
  dispatchStatus: string | undefined
  escalationsToCoordinatorHandle: number
  escalationsInRunMailbox: number
  totalUnreadForCoordinator: number
  escalation: Record<string, unknown> | null
  workerHandle: string
  runId: string
  taskId: string
}> {
  const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
  const db = new OrchestrationDb(':memory:')
  try {
    const lightweight = mode === 'lightweight-run'
    const runId = lightweight
      ? db.createRun({
          objective: 'sta-4604 lightweight run',
          coordinatorHandle,
          coordinatorPaneKey: COORDINATOR_PANE_KEY
        }).id
      : LEGACY_RUN_ID
    if (mode === 'legacy-run') {
      db.createCoordinatorRun({ spec: 'legacy coordinator loop', coordinatorHandle })
    }
    const task = db.createTask({ spec: 'do the work', runId })
    const dispatch = createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
    runtime.setOrchestrationDb(db as never)

    runtime.onPtyExit(WORKER_PTY_ID, 137)
    await settle()

    const direct = db.getUnreadMessages(coordinatorHandle, ['escalation'])
    const runMailbox = db.getUnreadRunMailbox(runId, 100, ['escalation'])
    const escalation = runMailbox[0] ?? direct[0]
    return {
      dispatchStatus: db.getDispatchContextById(dispatch.id)?.status,
      escalationsToCoordinatorHandle: direct.length,
      escalationsInRunMailbox: runMailbox.length,
      // The ticket's literal claim: the coordinator receives no message of any kind.
      totalUnreadForCoordinator:
        db.getUnreadMessages(coordinatorHandle).length + db.getUnreadRunMailbox(runId, 100).length,
      // Counts alone stay green while the escalation's content rots.
      escalation: escalation
        ? {
            from: escalation.from_handle,
            to: escalation.to_handle,
            runId: escalation.run_id,
            type: escalation.type,
            priority: escalation.priority,
            subject: escalation.subject,
            body: escalation.body,
            deliveryContract: escalation.delivery_contract,
            payload: JSON.parse(escalation.payload ?? 'null')
          }
        : null,
      workerHandle,
      runId,
      taskId: task.id
    }
  } finally {
    db.close()
  }
}

describe('STA-4604 worker PTY exit escalation reaches the coordinator', () => {
  // Why: every other case here uses a short single-line spec, where the derived title and the
  // raw spec are identical — so a refactor that inlines `task.spec` stays green while the
  // banner rots. Grade the prose the coordinator actually reads.
  it('titles the escalation from task_title, not the raw spec', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = db.createRun({
        objective: 'escalation prose',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      }).id
      const spec = `Fix the auth redirect loop\n\n${'detail '.repeat(60)}`
      const task = db.createTask({ spec, runId, taskTitle: 'Fix auth redirect' })
      createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
      runtime.setOrchestrationDb(db as never)

      runtime.onPtyExit(WORKER_PTY_ID, 137)
      await settle()

      const body = String(db.getUnreadRunMailbox(runId, 100, ['escalation'])[0]?.body ?? '')
      expect(body).toContain('"Fix auth redirect"')
      expect(body).not.toContain('detail detail')
      expect(body.split('\n')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('delivers the escalation to a lightweight Run mailbox', async () => {
    const graded = await gradeWorkerExit('lightweight-run')
    expect(graded).toMatchObject({
      dispatchStatus: 'failed',
      // Addressed run:<id> — the only address getOrCreateRunDelivery / getUnreadRunMailbox read.
      escalationsToCoordinatorHandle: 0,
      escalationsInRunMailbox: 1,
      totalUnreadForCoordinator: 1
    })
    expect(graded.escalation).toEqual({
      from: graded.workerHandle,
      to: `run:${graded.runId}`,
      runId: graded.runId,
      type: 'escalation',
      priority: 'high',
      subject: 'Agent exited unexpectedly (Agent process exited with code 137)',
      body:
        `Worker ${graded.workerHandle} stopped while running task ` +
        `"do the work" (${graded.taskId}). Agent process exited with code 137. ` +
        `The task is ready to be dispatched again.`,
      deliveryContract: 'current_delivery',
      payload: {
        taskId: expect.any(String),
        dispatchId: expect.any(String),
        exitCode: 137,
        // Why: the code alone cannot say whether the agent was killed, finished,
        // or was closed on purpose (STA-4603/STA-4536).
        exitCause: { kind: 'exited', exitCode: 137 },
        handle: graded.workerHandle
      }
    })
  })

  it('keeps legacy coordinator_runs delivery on the coordinator handle', async () => {
    const graded = await gradeWorkerExit('legacy-run')
    expect(graded).toMatchObject({
      dispatchStatus: 'failed',
      escalationsToCoordinatorHandle: 1,
      escalationsInRunMailbox: 0,
      totalUnreadForCoordinator: 1
    })
    expect(graded.escalation).toMatchObject({
      to: expect.stringMatching(/^term_/),
      runId: LEGACY_RUN_ID,
      type: 'escalation',
      subject: 'Agent exited unexpectedly (Agent process exited with code 137)'
    })
  })

  it('stays silent for a legacy dispatch with no active coordinator', async () => {
    await expect(gradeWorkerExit('legacy-run-no-coordinator')).resolves.toMatchObject({
      dispatchStatus: 'failed',
      escalationsToCoordinatorHandle: 0,
      escalationsInRunMailbox: 0,
      totalUnreadForCoordinator: 0,
      escalation: null
    })
  })

  it('wakes a coordinator already blocked in check --wait', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'sta-4604 blocking coordinator',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const task = db.createTask({ spec: 'do the work', runId: run.id })
      createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
      runtime.setOrchestrationDb(db as never)

      const waiting = runtime.waitForMessage(`run:${run.id}`, {
        typeFilter: ['escalation'],
        timeoutMs: 2_000
      })
      runtime.onPtyExit(WORKER_PTY_ID, 137)

      await expect(waiting).resolves.toBe('notified')
      // Why: waitForMessage resolves off the notification alone, so without this the test
      // would pass on a notify with no message behind it.
      expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toEqual([
        expect.objectContaining({
          run_id: run.id,
          to_handle: `run:${run.id}`,
          from_handle: workerHandle,
          type: 'escalation'
        })
      ])
      await settle()
    } finally {
      db.close()
    }
  })

  it('escalates only into the dying worker own Run when several Runs are live', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      // A second, more recently created Run is the trap: any "latest active run" lookup picks it.
      const ownRun = db.createRun({
        objective: 'run that owns the dying worker',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const otherRun = db.createRun({
        objective: 'unrelated newer run',
        coordinatorHandle: 'term_other_coordinator',
        coordinatorPaneKey: makePaneKey('tab-other', '33333333-3333-4333-8333-333333333333')
      })
      const task = db.createTask({ spec: 'owned work', runId: ownRun.id })
      createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
      runtime.setOrchestrationDb(db as never)

      runtime.onPtyExit(WORKER_PTY_ID, 137)
      await settle()

      expect({
        own: db.getUnreadRunMailbox(ownRun.id, 100, ['escalation']).length,
        other: db.getUnreadRunMailbox(otherRun.id, 100, ['escalation']).length
      }).toEqual({ own: 1, other: 0 })
    } finally {
      db.close()
    }
  })

  it('escalates for a supervised worker and settles its worker_dispatches row', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'supervised worker run',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const task = db.createTask({ spec: 'supervised work', runId: run.id })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'inc-1',
        worktreeId: WORKTREE_ID,
        effects: [],
        setupState: 'skipped'
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db as never)

      runtime.onPtyExit(WORKER_PTY_ID, 137)
      await settle()

      expect({
        dispatch: db.getDispatchContextById(started.dispatch.id)?.status,
        workerState: db.getWorkerDispatch(started.dispatch.id)?.state,
        workerStage: db.getWorkerDispatch(started.dispatch.id)?.stage,
        escalations: db.getUnreadRunMailbox(run.id, 100, ['escalation']).length
      }).toEqual({
        dispatch: 'failed',
        workerState: 'failed',
        workerStage: 'process_exited',
        escalations: 1
      })
    } finally {
      db.close()
    }
  })

  it('still escalates on the failure that breaks the circuit', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'circuit breaker run',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const task = db.createTask({ spec: 'repeatedly failing work', runId: run.id })
      // Burn the breaker down to its last life so this exit is the one that trips it.
      for (let attempt = 1; attempt < DISPATCH_CIRCUIT_BREAK_FAILURES; attempt += 1) {
        const previous = createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
        db.failDispatch(previous.id, `attempt ${attempt}`, { workerProcessExited: true })
      }
      const dispatch = createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
      runtime.setOrchestrationDb(db as never)

      runtime.onPtyExit(WORKER_PTY_ID, 137)
      await settle()

      const escalations = db.getUnreadRunMailbox(run.id, 100, ['escalation'])
      expect({
        dispatch: db.getDispatchContextById(dispatch.id)?.status,
        escalations: escalations.length
      }).toEqual({ dispatch: 'circuit_broken', escalations: 1 })
      // Why: a tripped breaker means nobody will retry it, so the body must not
      // tell the coordinator the task is ready to go again.
      expect(escalations.at(-1)?.body).toBe(
        `Worker ${workerHandle} stopped while running task ` +
          `"repeatedly failing work" (${task.id}). Agent process exited with code 137. ` +
          `This task has now failed too many ` +
          `times, so it will not be retried automatically.`
      )
    } finally {
      db.close()
    }
  })

  it('falls back to the legacy gate when the dispatch owning Run row is gone', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const insertMessage = vi.fn((message: { to: string }) => ({
      ...message,
      to_handle: message.to,
      type: 'escalation'
    }))
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: (handle: string) =>
        handle === workerHandle
          ? { id: 'ctx-orphan', run_id: 'run-that-no-longer-exists', task_id: 'task-orphan' }
          : undefined,
      failDispatch: vi.fn(),
      getRun: () => undefined,
      getActiveCoordinatorRun: () => ({ id: 'run-legacy', coordinator_handle: coordinatorHandle }),
      insertMessage
    } as never)

    runtime.onPtyExit(WORKER_PTY_ID, 137)

    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: coordinatorHandle, type: 'escalation' })
    )
    // An orphaned dispatch has no Run mailbox to address, so it must not invent one.
    expect(insertMessage.mock.calls[0]?.[0]).not.toHaveProperty('runId')
  })

  it('still reaches the Run mailbox when the Run has no bound coordinator', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'run whose coordinator later unbinds',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const task = db.createTask({ spec: 'work outliving its coordinator', runId: run.id })
      createRootDispatch(db, task.id, workerHandle, WORKER_PANE_KEY)
      // Rebinding the pane to a newer Run clears the old Run's coordinator_handle.
      db.createRun({
        objective: 'newer run on the same coordinator pane',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      expect(db.getRun(run.id)?.coordinator_handle).toBeNull()
      runtime.setOrchestrationDb(db as never)

      runtime.onPtyExit(WORKER_PTY_ID, 137)
      await settle()

      // Why: with no coordinator handle to address, only the durable run:<id> mailbox
      // keeps the escalation reachable for whoever rebinds next.
      expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toEqual([
        expect.objectContaining({ to_handle: `run:${run.id}`, run_id: run.id })
      ])
    } finally {
      db.close()
    }
  })

  // Resolving the recipient reads the DB too, so it needs the same protection as the insert.
  it.each([
    [
      'the recipient lookup',
      {
        getRun: () => {
          throw new Error('database is closed')
        }
      }
    ],
    [
      'the mailbox insert',
      {
        getRun: () => ({ id: 'run-1', legacy: 0, coordinator_handle: 'term_coord' }),
        insertMessage: () => {
          throw new Error('Run not found: run-1')
        }
      }
    ]
  ])('still finishes PTY exit when %s fails', (_case, dbOverrides) => {
    const { runtime, workerHandle } = makeRuntimeWithTwoPanes()
    const failDispatch = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: (handle: string) =>
        handle === workerHandle ? { id: 'ctx-1', run_id: 'run-1', task_id: 'task-1' } : undefined,
      failDispatch,
      getActiveCoordinatorRun: () => undefined,
      insertMessage: () => ({ to_handle: 'run:run-1', type: 'escalation' }),
      ...dbOverrides
    } as never)

    // Why: onPtyExit walks leaves synchronously — a throwing mailbox would abandon the
    // rest of the exit, so the worker death must stay durable and the exit must complete.
    expect(() => runtime.onPtyExit(WORKER_PTY_ID, 137)).not.toThrow()
    expect(failDispatch).toHaveBeenCalledWith('ctx-1', 'Agent process exited with code 137', {
      workerProcessExited: true,
      terminationReason: 'exited'
    })
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] failed to escalate worker exit',
      expect.objectContaining({ dispatchId: 'ctx-1', runId: 'run-1' })
    )
    warn.mockRestore()
  })
})
