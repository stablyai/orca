import { afterEach, describe, expect, it, vi } from 'vitest'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { OrchestrationDb } from './db'

afterEach(() => vi.useRealTimers())

const HELD = {
  paneKey: 'tab_held:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  processIncarnation: 'pty:held:1',
  hostScope: { kind: 'local', hostId: 'local' }
} as const

describe('coordinator census of a finished worker it still holds', () => {
  it('skips the held pane and creates a worker the ready task can go to', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    // The finished worker's Dispatch keeps custody of term_held until worker-start transfers it.
    const finished = db.createTask({ runId: 'run_legacy_local', spec: 'earlier work' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskId: finished.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_held',
      paneKey: HELD.paneKey,
      processIncarnation: HELD.processIncarnation,
      hostScope: JSON.stringify(HELD.hostScope),
      worktreeId: 'wt1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    db.abandonWorkerDispatch(started.dispatch.id, 'runtime-1')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'implement the feature' })

    const createTerminal = vi.fn<CoordinatorRuntime['createTerminal']>(async () => ({
      handle: 'term_new',
      worktreeId: 'wt1'
    }))
    const runtime: CoordinatorRuntime = {
      listTerminals: async () => ({
        terminals: [{ handle: 'term_held', worktreeId: 'wt1', connected: true, writable: true }]
      }),
      createTerminal,
      sendTerminalAgentPrompt: async () => ({ accepted: true }),
      waitForTerminal: async (handle) => ({ handle, condition: 'exit' }),
      probeWorktreeDrift: async () => null,
      getOrchestrationDispatchAuthority: (handle) =>
        handle === 'term_held' ? { ...HELD, launchTokenHash: null } : null
    }
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 1000,
      worktree: 'wt1'
    })
    const run = coordinator.run()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(createTerminal).toHaveBeenCalledTimes(1)
      expect(db.getDispatchContext(task.id)?.assignee_handle).toBe('term_new')
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    } finally {
      coordinator.stop()
      try {
        await vi.runOnlyPendingTimersAsync()
        await run
      } finally {
        db.close()
      }
    }
  })

  it('skips a reminted handle of a pane that already works an active Dispatch', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const working = db.createTask({ runId: 'run_legacy_local', spec: 'earlier work' })
    db.createDispatchContext({
      taskId: working.id,
      assigneeHandle: 'term_old',
      assigneePaneKey: HELD.paneKey,
      creator: { kind: 'system' },
      maxDepth: 9
    })
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'implement the feature' })

    const createTerminal = vi.fn<CoordinatorRuntime['createTerminal']>(async () => ({
      handle: 'term_new',
      worktreeId: 'wt1'
    }))
    const runtime: CoordinatorRuntime = {
      // The same pane, listed under the handle it was reminted to.
      listTerminals: async () => ({
        terminals: [{ handle: 'term_reminted', worktreeId: 'wt1', connected: true, writable: true }]
      }),
      createTerminal,
      sendTerminalAgentPrompt: async () => ({ accepted: true }),
      waitForTerminal: async (handle) => ({ handle, condition: 'exit' }),
      probeWorktreeDrift: async () => null,
      getTerminalPaneKey: (handle) => (handle === 'term_reminted' ? HELD.paneKey : null)
    }
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 1000,
      worktree: 'wt1',
      maxConcurrent: 2
    })
    const run = coordinator.run()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(createTerminal).toHaveBeenCalledTimes(1)
      expect(db.getDispatchContext(task.id)?.assignee_handle).toBe('term_new')
    } finally {
      coordinator.stop()
      try {
        await vi.runOnlyPendingTimersAsync()
        await run
      } finally {
        db.close()
      }
    }
  })
})
