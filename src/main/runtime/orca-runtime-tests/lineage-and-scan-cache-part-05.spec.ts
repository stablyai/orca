import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { join } from 'node:path'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { tmpdir } from 'node:os'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('uses durable Run ownership before worktree-scoped legacy attribution', async () => {
    const childWorktreeId = `${TEST_REPO_ID}::${join(tmpdir(), 'workspaces', 'run-a-worker')}`
    const folderWorktreeId = `${TEST_REPO_ID}::${join(tmpdir(), 'folder')}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    const meta = store.getAllWorktreeMeta()[TEST_WORKTREE_ID]
    const metaById = {
      ...store.getAllWorktreeMeta(),
      [childWorktreeId]: meta,
      [folderWorktreeId]: meta
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    } as never)
    const terminals = [
      {
        name: 'coordinator-a',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '11111111-1111-4111-8111-111111111111'
      },
      {
        name: 'coordinator-b',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '22222222-2222-4222-8222-222222222222'
      },
      {
        name: 'worker-cross-worktree',
        worktreeId: childWorktreeId,
        leafId: '33333333-3333-4333-8333-333333333333'
      },
      {
        name: 'worker-same-worktree',
        worktreeId: TEST_WORKTREE_ID,
        leafId: '44444444-4444-4444-8444-444444444444'
      },
      {
        name: 'worker-folder',
        worktreeId: folderWorktreeId,
        leafId: '55555555-5555-4555-8555-555555555555'
      },
      {
        name: 'legacy-worker',
        worktreeId: childWorktreeId,
        leafId: '66666666-6666-4666-8666-666666666666'
      }
    ].map((terminal, index) => ({
      ...terminal,
      tabId: `tab-${terminal.name}`,
      ptyId: `pty-${terminal.name}`,
      paneRuntimeId: index + 1
    }))
    const terminalByName = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, terminal])
    )
    const handles = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, runtime.preAllocateHandleForPty(terminal.ptyId)])
    )
    const paneKey = (name: string): string => {
      const terminal = terminalByName[name]
      return makePaneKey(terminal.tabId, terminal.leafId)
    }
    const db = new OrchestrationDb(':memory:')
    try {
      const runA = db.createRun({
        objective: 'coordinate run A',
        coordinatorHandle: handles['coordinator-a'],
        coordinatorPaneKey: paneKey('coordinator-a')
      })
      const runB = db.createRun({
        objective: 'coordinate run B',
        coordinatorHandle: handles['coordinator-b'],
        coordinatorPaneKey: paneKey('coordinator-b')
      })
      const dispatches = Object.fromEntries(
        [
          ['worker-cross-worktree', runA.id],
          ['worker-same-worktree', runA.id],
          ['worker-folder', runB.id]
        ].map(([name, runId]) => {
          const task = db.createTask({ spec: name, runId })
          return [name, createRootDispatch(db, task.id, handles[name], paneKey(name))]
        })
      )
      const legacyTask = db.createTask({
        runId: 'run_legacy_local',
        spec: 'legacy worker'
      })
      const legacyDispatch = createRootDispatch(
        db,
        legacyTask.id,
        handles['legacy-worker'],
        paneKey('legacy-worker')
      )
      db.createCoordinatorRun({
        spec: 'unrelated legacy coordinator',
        coordinatorHandle: handles['coordinator-b']
      })
      const getActiveCoordinatorRun = vi.spyOn(db, 'getActiveCoordinatorRun')
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)

      const result = await runtime.syncWindowGraph(1, {
        tabs: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: terminal.worktreeId,
          title: terminal.name,
          activeLeafId: terminal.leafId,
          layout: null
        })),
        leaves: terminals.map((terminal) => ({
          tabId: terminal.tabId,
          worktreeId: terminal.worktreeId,
          leafId: terminal.leafId,
          paneRuntimeId: terminal.paneRuntimeId,
          ptyId: terminal.ptyId,
          paneTitle: null
        }))
      })

      for (const [name, run, coordinator] of [
        ['worker-cross-worktree', runA, 'coordinator-a'],
        ['worker-same-worktree', runA, 'coordinator-a'],
        ['worker-folder', runB, 'coordinator-b']
      ] as const) {
        expect(result.agentOrchestrationByPaneKey?.[paneKey(name)]).toMatchObject({
          taskId: dispatches[name].task_id,
          dispatchId: dispatches[name].id,
          dispatchStatus: 'dispatched',
          parentTerminalHandle: handles[coordinator],
          parentPaneKey: paneKey(coordinator),
          coordinatorHandle: handles[coordinator],
          orchestrationRunId: run.id
        })
      }
      const legacyContext = result.agentOrchestrationByPaneKey?.[paneKey('legacy-worker')]
      expect(legacyContext).toMatchObject({
        taskId: legacyTask.id,
        dispatchId: legacyDispatch.id,
        dispatchStatus: 'dispatched'
      })
      expect(legacyContext).not.toHaveProperty('parentTerminalHandle')
      expect(legacyContext).not.toHaveProperty('coordinatorHandle')
      expect(legacyContext).not.toHaveProperty('orchestrationRunId')
      expect(getActiveCoordinatorRun).toHaveBeenCalledOnce()
    } finally {
      db.close()
    }
  })

  it('uses the still-bound owning Run coordinator after a creator pane rebinds', async () => {
    const runtime = new OrcaRuntimeService(store)
    const terminals = [
      {
        name: 'coordinator',
        leafId: '11111111-1111-4111-8111-111111111111'
      },
      {
        name: 'creator',
        leafId: '22222222-2222-4222-8222-222222222222'
      },
      {
        name: 'worker',
        leafId: '33333333-3333-4333-8333-333333333333'
      },
      {
        name: 'coordinator-created-worker',
        leafId: '44444444-4444-4444-8444-444444444444'
      }
    ].map((terminal, index) => ({
      ...terminal,
      tabId: `tab-${terminal.name}`,
      ptyId: `pty-${terminal.name}`,
      paneRuntimeId: index + 1
    }))
    const terminalByName = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, terminal])
    )
    const handles = Object.fromEntries(
      terminals.map((terminal) => [terminal.name, runtime.preAllocateHandleForPty(terminal.ptyId)])
    )
    const paneKey = (name: string): string => {
      const terminal = terminalByName[name]
      return makePaneKey(terminal.tabId, terminal.leafId)
    }
    const graph = () => ({
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
    })
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.attachWindow(1)
      await runtime.syncWindowGraph(1, graph())
      const runA = db.createRun({
        objective: 'own the nested worker',
        coordinatorHandle: handles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      const creatorAuthority = runtime.getOrchestrationDispatchAuthority(handles.creator)
      const coordinatorAuthority = runtime.getOrchestrationDispatchAuthority(handles.coordinator)
      expect(creatorAuthority?.processIncarnation).toBeTruthy()
      expect(coordinatorAuthority?.processIncarnation).toBeTruthy()
      const creatorTask = db.createTask({ spec: 'create nested work', runId: runA.id })
      createRootDispatch(
        db,
        creatorTask.id,
        handles.creator,
        paneKey('creator'),
        undefined,
        creatorAuthority?.processIncarnation ?? undefined
      )
      const workerTask = db.createTask({
        spec: 'nested work',
        runId: runA.id,
        createdByTerminalHandle: handles.creator,
        createdByPaneKey: paneKey('creator'),
        createdByProcessIncarnation: creatorAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: runA.consumer_generation
      })
      const workerDispatch = createRootDispatch(
        db,
        workerTask.id,
        handles.worker,
        paneKey('worker')
      )
      const coordinatorCreatedTask = db.createTask({
        spec: 'coordinator-created work',
        runId: runA.id,
        createdByTerminalHandle: handles.coordinator,
        createdByPaneKey: paneKey('coordinator'),
        createdByProcessIncarnation: coordinatorAuthority?.processIncarnation ?? undefined,
        createdByRunGeneration: runA.consumer_generation
      })
      const coordinatorCreatedDispatch = createRootDispatch(
        db,
        coordinatorCreatedTask.id,
        handles['coordinator-created-worker'],
        paneKey('coordinator-created-worker')
      )
      expect(
        (await runtime.syncWindowGraph(1, graph())).agentOrchestrationByPaneKey?.[paneKey('worker')]
      ).toMatchObject({
        parentTerminalHandle: handles.creator,
        parentPaneKey: paneKey('creator'),
        coordinatorHandle: handles.coordinator,
        orchestrationRunId: runA.id
      })

      const oldCreatorPaneKey = paneKey('creator')
      terminalByName.creator.tabId = 'tab-creator-reminted'
      terminalByName.creator.ptyId = 'pty-creator-reminted'
      const remintedCreatorHandle = runtime.preAllocateHandleForPty(terminalByName.creator.ptyId)
      await runtime.syncWindowGraph(1, graph())
      const runB = db.createRun({
        objective: 'rebind the creator pane',
        coordinatorHandle: remintedCreatorHandle,
        coordinatorPaneKey: paneKey('creator')
      })
      const reboundContext = (await runtime.syncWindowGraph(1, graph()))
        .agentOrchestrationByPaneKey?.[paneKey('worker')]

      expect(db.getRun(runA.id)).toMatchObject({
        coordinator_handle: handles.coordinator,
        consumer_generation: 1
      })
      expect(oldCreatorPaneKey).not.toBe(paneKey('creator'))
      expect(db.getRun(runB.id)).toMatchObject({ coordinator_handle: remintedCreatorHandle })
      expect(reboundContext).toMatchObject({
        taskId: workerTask.id,
        dispatchId: workerDispatch.id,
        dispatchStatus: 'dispatched',
        parentTerminalHandle: handles.coordinator,
        parentPaneKey: paneKey('coordinator'),
        coordinatorHandle: handles.coordinator,
        orchestrationRunId: runA.id
      })

      const runC = db.createRun({
        objective: 'rebind the original coordinator pane',
        coordinatorHandle: handles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      db.bindRun({
        runId: runC.id,
        coordinatorHandle: handles.coordinator,
        coordinatorPaneKey: paneKey('coordinator')
      })
      const unboundContext = (await runtime.syncWindowGraph(1, graph()))
        .agentOrchestrationByPaneKey?.[paneKey('coordinator-created-worker')]

      expect(db.getRun(runA.id)).toMatchObject({
        coordinator_handle: null,
        coordinator_pane_key: null,
        consumer_generation: 2
      })
      expect(unboundContext).toEqual({
        taskId: coordinatorCreatedTask.id,
        dispatchId: coordinatorCreatedDispatch.id,
        dispatchStatus: 'dispatched',
        taskTitle: 'coordinator-created work',
        displayName: 'coordinator-created work',
        orchestrationRunId: runA.id,
        attention: {
          categories: ['unverifiable'],
          requiresAction: true
        }
      })
    } finally {
      db.close()
    }
  })
})
