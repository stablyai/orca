import { describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../construction/test-context/orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

const SESSION = { key: 'session_id', id: 'claude-session-1' } as const
const DEAD_PANE_KEY = 'crashed-worker-tab:44444444-4444-4444-8444-444444444444'

function setup(
  resumeWorkOnRestart: boolean,
  presence?: 'working' | 'resting',
  pane: { paneKey: string; processIncarnation: string } = {
    paneKey: DEAD_PANE_KEY,
    processIncarnation: 'pty-lost:55555555-5555-4555-8555-555555555555'
  }
) {
  const paneAgentListeners: ((
    sessions: readonly { paneKey: string; sessionId: string }[]
  ) => void)[] = []
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const settings = runtimeStore.getSettings()
  const runtime = new OrcaRuntimeService(
    withDurableRuntimeStore({
      ...runtimeStore,
      getSettings: () => ({ ...settings, nativeChatResumeWorkOnRestart: resumeWorkOnRestart }),
      flushOrThrow: vi.fn()
    }),
    undefined,
    {
      canRecoverPersistentLocalPtys: () => true,
      getDesktopWindowStatus: () => 'openable',
      getAgentProviderSessionSnapshot: () => [],
      checkHookAgentPresence: async () => null,
      subscribeAgentProviderSessionChanges: (listener) => {
        paneAgentListeners.push(listener)
        return () => {}
      }
    }
  )
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'reboot',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = db.createTask({ spec: 'keep working', runId: run.id })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { topology: 'current', agent: 'claude' }
  })
  const dispatchId = started.dispatch.id
  db.prepareStartingWorkerAuthority({
    dispatchId,
    handle: 'term_lost_worker',
    ...pane,
    worktreeId: TEST_WORKTREE_ID,
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatchId)
  db.db
    .prepare('UPDATE worker_terminal_resources SET resume_session = ? WHERE owner_dispatch_id = ?')
    .run(
      JSON.stringify({ agent: 'claude', providerSession: SESSION, connectionId: null }),
      dispatchId
    )
  if (presence) {
    db.db
      .prepare(`INSERT INTO worker_presence (dispatch_id, presence, generation) VALUES (?, ?, 1)`)
      .run(dispatchId, presence)
  }
  runtime.setOrchestrationDb(db)
  const spawn = vi.fn(async () => ({ id: 'resumed-pty' }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: () => false,
    listProcesses: async () => []
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only this notifier method.
  runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery: vi.fn() } as never)
  return {
    runtime,
    db,
    dispatchId,
    spawn,
    reportPaneAgents: (paneKey: string) =>
      paneAgentListeners.forEach((listener) => listener([{ paneKey, sessionId: SESSION.id }]))
  }
}

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const LIVE_PANE_KEY = `${TAB_ID}:${LEAF_ID}`

async function placeWorkerPane(
  runtime: OrcaRuntimeService,
  ptyId: string,
  incarnationId: string,
  handle: string
): Promise<void> {
  runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId
  })
  runtime.registerPreAllocatedHandleForPty(ptyId, handle)
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'Worker',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: TEST_WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId }
    ]
  })
}

const LOST_INCARNATION = '66666666-6666-4666-8666-666666666666'
const RESUMED_INCARNATION = '77777777-7777-4777-8777-777777777777'

describe('terminal worker resume after a terminal daemon crash', () => {
  for (const resumeWorkOnRestart of [false, true]) {
    it(`with Resume work on restart ${resumeWorkOnRestart ? 'on' : 'off'}`, async () => {
      const { runtime, db, dispatchId, reportPaneAgents } = setup(resumeWorkOnRestart, 'resting', {
        paneKey: LIVE_PANE_KEY,
        processIncarnation: `pty-worker:${LOST_INCARNATION}`
      })
      try {
        await placeWorkerPane(runtime, 'pty-worker', LOST_INCARNATION, 'term_lost_worker')
        // The pane starts again in place and its old process is gone with the daemon.
        await runtime.onPtyExit('pty-worker', -1, LOST_INCARNATION, {
          hostExitConfirmed: true,
          paneRespawning: true
        })
        if (!resumeWorkOnRestart) {
          expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
          return
        }
        expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
        await placeWorkerPane(runtime, 'pty-worker-2', RESUMED_INCARNATION, 'term_resumed_worker')
        reportPaneAgents(LIVE_PANE_KEY)
        await vi.waitFor(() =>
          expect(db.getDispatchContextById(dispatchId)).toMatchObject({
            status: 'dispatched',
            assignee_handle: 'term_resumed_worker',
            assignee_pane_key: LIVE_PANE_KEY,
            process_incarnation: `pty-worker-2:${RESUMED_INCARNATION}`
          })
        )
        expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
      } finally {
        db.close()
      }
    })
  }
})

describe('terminal worker resume after a reboot', () => {
  it('with Resume work on restart off, fails the lost worker as before', async () => {
    const { runtime, db, dispatchId, spawn } = setup(false, 'working')
    try {
      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        exitedDispatchIds: [dispatchId]
      })
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
      expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
        state: 'abandoned',
        stage: 'terminal_missing'
      })
      void runtime.reportWorkerStopsAcrossRestartOnce()
      await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned'))
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('with it on, keeps the Dispatch and resumes its conversation in a new terminal', async () => {
    const { runtime, db, dispatchId, spawn } = setup(true, 'resting')
    try {
      const result = await runtime.reconcileLegacyWorkerTerminals()
      expect(result.exitedDispatchIds).toEqual([])
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
        state: 'ready',
        stage: 'restart_resumed'
      })
      // Nothing reopens until restored terminals are placed.
      expect(spawn).not.toHaveBeenCalled()

      void runtime.reportWorkerStopsAcrossRestartOnce()
      await vi.waitFor(() =>
        expect(db.getDispatchContextById(dispatchId)?.assignee_handle).not.toBe('term_lost_worker')
      )
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(spawn.mock.calls[0])).toContain('--resume')
      expect(JSON.stringify(spawn.mock.calls[0])).toContain(SESSION.id)
      const dispatch = db.getDispatchContextById(dispatchId)
      expect(dispatch).toMatchObject({ status: 'dispatched' })
      expect(dispatch?.assignee_pane_key).not.toBe(DEAD_PANE_KEY)
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        terminal_handle: dispatch?.assignee_handle,
        pane_key: dispatch?.assignee_pane_key
      })
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('resumes a Dispatch once: a second loss fails it as before', async () => {
    const { runtime, db, dispatchId } = setup(true, 'resting')
    try {
      db.db
        .prepare("UPDATE worker_dispatches SET stage = 'restart_resumed' WHERE dispatch_id = ?")
        .run(dispatchId)
      await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
        exitedDispatchIds: [dispatchId]
      })
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('abandoned')
    } finally {
      db.close()
    }
  })
})
