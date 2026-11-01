import { describe, expect, it } from 'vitest'
import {
  OrcaRuntimeService,
  OrchestrationDb,
  createRootDispatch,
  makePaneKey
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

type RestartTerminal = {
  name: string
  leafId: string
  tabId: string
  ptyId: string
  paneRuntimeId: number
}

function makeTerminals(): RestartTerminal[] {
  return [
    { name: 'coordinator', leafId: '11111111-1111-4111-8111-111111111111' },
    { name: 'worker', leafId: '22222222-2222-4222-8222-222222222222' },
    { name: 'nested-worker', leafId: '33333333-3333-4333-8333-333333333333' }
  ].map((terminal, index) => ({
    ...terminal,
    tabId: `tab-${terminal.name}`,
    ptyId: `pty-${terminal.name}`,
    paneRuntimeId: index + 1
  }))
}

function makeGraph(terminals: readonly RestartTerminal[]) {
  return {
    tabs: terminals.map((terminal) => ({
      tabId: terminal.tabId,
      worktreeId: TEST_WORKTREE_ID,
      title: terminal.name,
      activeLeafId: terminal.leafId,
      layout: null
    })),
    leaves: terminals.map((terminal) => ({
      tabId: terminal.tabId,
      worktreeId: TEST_WORKTREE_ID,
      leafId: terminal.leafId,
      paneRuntimeId: terminal.paneRuntimeId,
      ptyId: terminal.ptyId,
      paneTitle: null
    }))
  }
}

/** Restart retains graph/daemon worker handles, but remints coordinator handles until orchestration rebinds them. */
function lineageOf<T extends { attention?: unknown }>(
  context: T | undefined
): Omit<T, 'attention'> | undefined {
  if (!context) {
    return undefined
  }
  const { attention: _attention, ...lineage } = context
  return lineage
}

describe('OrcaRuntimeService orchestration lineage across restart', () => {
  it('projects the coordinator pane key as the worker parent after the handles are reminted', () => {
    const terminals = makeTerminals()
    const paneKey = (name: string): string => {
      const terminal = terminals.find((entry) => entry.name === name) as RestartTerminal
      return makePaneKey(terminal.tabId, terminal.leafId)
    }
    const db = new OrchestrationDb(':memory:')
    const before = new OrcaRuntimeService(store)
    try {
      const beforeHandles = Object.fromEntries(
        terminals.map((terminal) => [terminal.name, before.preAllocateHandleForPty(terminal.ptyId)])
      )
      before.setOrchestrationDb(db)
      before.attachWindow(1)
      before.syncWindowGraph(1, makeGraph(terminals))
      const coordinatorAuthority = before.getOrchestrationDispatchAuthority(
        beforeHandles.coordinator
      )
      expect(coordinatorAuthority?.processIncarnation).toBeTruthy()
      const run = db.createRun({
        objective: 'survive a restart',
        coordinatorHandle: beforeHandles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      const workerTask = db.createTask({
        spec: 'worker task',
        runId: run.id,
        createdByTerminalHandle: beforeHandles.coordinator,
        createdByPaneKey: paneKey('coordinator'),
        createdByProcessIncarnation: coordinatorAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: run.consumer_generation
      })
      const workerAuthority = before.getOrchestrationDispatchAuthority(beforeHandles.worker)
      const workerDispatch = createRootDispatch(
        db,
        workerTask.id,
        beforeHandles.worker,
        paneKey('worker'),
        undefined,
        workerAuthority?.processIncarnation ?? undefined
      )
      const nestedTask = db.createTask({
        spec: 'nested task',
        runId: run.id,
        createdByTerminalHandle: beforeHandles.worker,
        createdByPaneKey: paneKey('worker'),
        createdByProcessIncarnation: workerAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: run.consumer_generation
      })
      const nestedDispatch = createRootDispatch(
        db,
        nestedTask.id,
        beforeHandles['nested-worker'],
        paneKey('nested-worker')
      )
      expect(
        before.syncWindowGraph(1, makeGraph(terminals)).agentOrchestrationByPaneKey
      ).toMatchObject({
        [paneKey('worker')]: {
          parentTerminalHandle: beforeHandles.coordinator,
          parentPaneKey: paneKey('coordinator')
        },
        [paneKey('nested-worker')]: {
          parentTerminalHandle: beforeHandles.worker,
          parentPaneKey: paneKey('worker')
        }
      })

      // Restart re-adopts live daemon worker handles; runs still name the old, not-yet-rebound coordinator handle.
      const after = new OrcaRuntimeService(store)
      after.registerPreAllocatedHandleForPty('pty-worker', beforeHandles.worker)
      after.registerPreAllocatedHandleForPty('pty-nested-worker', beforeHandles['nested-worker'])
      const freshCoordinatorHandle = after.preAllocateHandleForPty('pty-coordinator')
      expect(freshCoordinatorHandle).not.toBe(beforeHandles.coordinator)
      after.setOrchestrationDb(db)
      after.attachWindow(1)
      const contexts = after.syncWindowGraph(1, makeGraph(terminals)).agentOrchestrationByPaneKey

      expect(db.getRun(run.id)?.coordinator_handle).toBe(beforeHandles.coordinator)
      expect(lineageOf(contexts?.[paneKey('worker')])).toEqual({
        taskId: workerTask.id,
        dispatchId: workerDispatch.id,
        dispatchStatus: 'dispatched',
        taskTitle: 'worker task',
        displayName: 'worker task',
        parentTerminalHandle: freshCoordinatorHandle,
        parentPaneKey: paneKey('coordinator'),
        coordinatorHandle: freshCoordinatorHandle,
        orchestrationRunId: run.id
      })
      // Worker incarnation gates authority; durable pane keys must still nest its child rather than falling to coordinator.
      expect(lineageOf(contexts?.[paneKey('nested-worker')])).toEqual({
        taskId: nestedTask.id,
        dispatchId: nestedDispatch.id,
        dispatchStatus: 'dispatched',
        taskTitle: 'nested task',
        displayName: 'nested task',
        parentTerminalHandle: beforeHandles.worker,
        parentPaneKey: paneKey('worker'),
        coordinatorHandle: freshCoordinatorHandle,
        orchestrationRunId: run.id
      })
    } finally {
      db.close()
    }
  })

  it('omits a stale coordinator handle when no live pane owns the coordinator pane key', () => {
    const terminals = makeTerminals().filter((terminal) => terminal.name === 'worker')
    const workerPaneKey = makePaneKey('tab-worker', terminals[0]!.leafId)
    const coordinatorPaneKey = makePaneKey(
      'tab-coordinator',
      '11111111-1111-4111-8111-111111111111'
    )
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(store)
    try {
      const workerHandle = runtime.preAllocateHandleForPty('pty-worker')
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)
      const run = db.createRun({
        objective: 'coordinator pane closed before restart',
        coordinatorHandle: 'term_stale-coordinator',
        coordinatorPaneKey: coordinatorPaneKey
      })
      const task = db.createTask({ spec: 'orphaned worker', runId: run.id })
      const dispatch = createRootDispatch(db, task.id, workerHandle, workerPaneKey)

      const context = runtime.syncWindowGraph(1, makeGraph(terminals))
        .agentOrchestrationByPaneKey?.[workerPaneKey]

      // Never publish handles lacking live rows; keep durable pane keys so restored panes recover nesting.
      expect(lineageOf(context)).toEqual({
        taskId: task.id,
        dispatchId: dispatch.id,
        dispatchStatus: 'dispatched',
        taskTitle: 'orphaned worker',
        displayName: 'orphaned worker',
        parentPaneKey: coordinatorPaneKey,
        orchestrationRunId: run.id
      })
    } finally {
      db.close()
    }
  })
})
