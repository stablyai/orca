import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const WORKTREE_ID = 'repo-1::/tmp/codex-reconnect-failed'
const WORKER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const COORDINATOR_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WORKER_PTY_ID = 'pty-codex-worker'
const COORDINATOR_PTY_ID = 'pty-coordinator'
const WORKER_PANE_KEY = makePaneKey('tab-worker', WORKER_LEAF_ID)
const COORDINATOR_PANE_KEY = makePaneKey('tab-coordinator', COORDINATOR_LEAF_ID)

const RECONNECT_FAILURE_BANNER = [
  'Automatic reconnect could not restore this session',
  'app-server session could not be restored',
  'Reconnect failed — check the endpoint, then relaunch'
].join('\r\n')

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/codex-reconnect-failed',
        displayName: 'codex-reconnect-failed',
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

function makeRuntime() {
  const kill = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime constructor only reaches the WorkspaceSession, repo, worktree metadata, settings, and project reads supplied by this fixture.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const ptyController = {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: vi.fn(() => true),
    kill,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the spawn, write, kill, foreground-process, and process-list operations reached by the runtime path under test.
  runtime.setPtyController(ptyController as never)
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
  return { runtime, kill, workerHandle, coordinatorHandle }
}

function attachOrchestrationDb(runtime: OrcaRuntimeService, db: OrchestrationDb): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: db is the real OrchestrationDb implementation; the assertion bridges the runtime's narrower test-facing storage port.
  runtime.setOrchestrationDb(db as never)
}

describe('Codex reconnect failure settles its worker dispatch', () => {
  it('fails and escalates the explicit unrecoverable-session banner but keeps the PTY alive', async () => {
    const { runtime, kill, workerHandle, coordinatorHandle } = makeRuntime()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'settle unrecoverable Codex session',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'run work in a Codex worker',
        taskRunId: run.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'runtime:pty:codex-worker',
        worktreeId: WORKTREE_ID,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', action: 'created', id: workerHandle }],
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      attachOrchestrationDb(runtime, db)

      expect(() =>
        db.failDispatch(started.dispatch.id, 'no authoritative session failure')
      ).toThrow(/active supervised worker/)
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: emulate a remaining synthetic PTY handle after its cached PTY ID index is absent.
      const runtimeHandleIndexes = runtime as unknown as {
        handleByPtyId: Map<string, string>
        handles: Map<string, { ptyId: string; tabId: string }>
      }
      const syntheticHandle = runtimeHandleIndexes.handles.get(workerHandle)
      expect(syntheticHandle?.ptyId).toBe(WORKER_PTY_ID)
      if (syntheticHandle) {
        syntheticHandle.tabId = `pty:${WORKER_PTY_ID}`
      }
      runtimeHandleIndexes.handleByPtyId.delete(WORKER_PTY_ID)

      runtime.onPtyData(
        WORKER_PTY_ID,
        '\x1b[1mAutomatic reconnect could not restore this session\x1b[0m\r\napp-server session could not be restored\r\nReconnect failed — check the endpoint, then re',
        100
      )
      runtime.onPtyData(WORKER_PTY_ID, 'launch', 101)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'failed',
        termination_reason: null
      })
      expect(db.getTask(started.task.id)?.status).toBe('failed')
      expect(db.getWorkerDispatch(started.dispatch.id)).toMatchObject({
        state: 'failed',
        stage: 'session_unrecoverable'
      })
      expect(db.getWorkerTerminalResourceByOwner(started.dispatch.id)).toMatchObject({
        release_state: 'not_requested',
        ownership_state: 'owned'
      })
      expect(
        db.getUnreadRunMailbox(run.id, 100, ['escalation']).map(({ subject, body }) => ({
          subject,
          body
        }))
      ).toEqual([
        {
          subject: 'Agent session failed (Codex could not restore its app-server session)',
          body: expect.stringContaining(
            'The task was marked failed pending coordinator review and will not be retried automatically.'
          )
        }
      ])
      expect(kill).not.toHaveBeenCalled()

      const nextTask = db.createTask({ runId: run.id, spec: 'run the next Codex worker task' })
      const next = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: nextTask.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: next.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'runtime:pty:codex-worker',
        worktreeId: WORKTREE_ID,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'external'
      })
      db.markWorkerDispatchReady(next.dispatch.id)

      runtime.onPtyData(WORKER_PTY_ID, 'next task started\r\n', 102)
      expect(db.getDispatchContextById(next.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(next.dispatch.id)?.state).toBe('ready')

      runtime.onPtyData(WORKER_PTY_ID, RECONNECT_FAILURE_BANNER, 103)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(db.getDispatchContextById(next.dispatch.id)?.status).toBe('failed')
      expect(db.getTask(nextTask.id)?.status).toBe('failed')
      expect(
        db
          .getUnreadRunMailbox(run.id, 100, ['escalation'])
          .filter(({ subject }) => subject.includes('Agent session failed'))
      ).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('ignores a reconnect banner that began before a later dispatch started', () => {
    const { runtime, kill, workerHandle, coordinatorHandle } = makeRuntime()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'start a Codex worker after old terminal output',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      attachOrchestrationDb(runtime, db)
      runtime.onPtyData(
        WORKER_PTY_ID,
        'Automatic reconnect could not restore this session\r\napp-server session could not be restored\r\n',
        100
      )

      const task = db.createTask({ runId: run.id, spec: 'keep the new dispatch active' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'runtime:pty:codex-worker',
        worktreeId: WORKTREE_ID,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'external'
      })
      db.markWorkerDispatchReady(started.dispatch.id)

      runtime.onPtyData(WORKER_PTY_ID, 'Reconnect failed — check the endpoint, then relaunch', 101)

      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('does not settle a worker from a partial reconnect banner', () => {
    const { runtime, kill, workerHandle } = makeRuntime()
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ runId: LEGACY_RUN_ID, spec: 'keep a live worker active' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'runtime:pty:codex-worker',
        worktreeId: WORKTREE_ID,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      attachOrchestrationDb(runtime, db)

      runtime.onPtyData(
        WORKER_PTY_ID,
        'Automatic reconnect could not restore this session\r\napp-server session could not be restored',
        100
      )

      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('does not apply the Codex banner rule to another agent', () => {
    const { runtime, kill, workerHandle } = makeRuntime()
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ runId: LEGACY_RUN_ID, spec: 'keep a Claude worker active' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'claude' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: workerHandle,
        paneKey: WORKER_PANE_KEY,
        processIncarnation: 'runtime:pty:claude-worker',
        worktreeId: WORKTREE_ID,
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      attachOrchestrationDb(runtime, db)

      runtime.onPtyData(WORKER_PTY_ID, RECONNECT_FAILURE_BANNER, 100)

      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
