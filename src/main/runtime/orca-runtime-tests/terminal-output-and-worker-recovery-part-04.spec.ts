import '../orchestration/crew/crew-changes'
import './runtime-orchestration-db.test-fixture'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('requeues an active Task before clearing recovery for an authoritatively missing worker', async () => {
    const workerPaneKey = `legacy-missing:${HEADLESS_LEAF_ID}`
    const incarnationId = '32323232-3232-4232-8232-323232323232'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-missing',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-missing-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const flushPendingOrThrowAsync = vi.fn(() => {
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const flushOrThrow = vi.fn(() => {
      throw new Error('synchronous persistence must not run')
    })
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow, flushPendingOrThrowAsync }),
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'continue after missing worker recovery'
      })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_missing_worker',
        paneKey: workerPaneKey,
        processIncarnation: `pty-missing-worker:${incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      const resolveLegacyWorkerTerminalRecovery = vi.fn()
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)

      const recovery = runtime.reconcileLegacyWorkerTerminals()
      await durableWriteStarted.promise

      expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      durableWrite.resolve()

      await expect(recovery).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })

      expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()
      expect(flushPendingOrThrowAsync).toHaveBeenCalledWith({
        drainToStableGeneration: false
      })
      expect(flushOrThrow).not.toHaveBeenCalled()
      expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'failed',
        failure_count: 1
      })
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('abandoned')
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        workerPaneKey,
        'rolled_back',
        'pty-missing-worker'
      )
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
    } finally {
      db.close()
    }
  })

  it('waits for durability before retry settles a resolution already present in memory', async () => {
    const workerPaneKey = `legacy-missing-retry:${HEADLESS_LEAF_ID}`
    const incarnationId = '34343434-3434-4434-8434-343434343434'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-missing-retry',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-missing-retry-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const firstDurableWrite = deferred<void>()
    const firstDurableWriteStarted = deferred<void>()
    const retryDurableWrite = deferred<void>()
    const retryDurableWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        firstDurableWriteStarted.resolve()
        return firstDurableWrite.promise
      }
      retryDurableWriteStarted.resolve()
      return retryDurableWrite.promise
    })
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushPendingOrThrowAsync }),
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'retry missing worker recovery'
      })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_missing_retry',
        paneKey: workerPaneKey,
        processIncarnation: `pty-missing-retry:${incarnationId}`,
        worktreeId: TEST_WORKTREE_ID,
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      runtime.setOrchestrationDb(db)
      runtime.setPtyController({
        write: vi.fn(() => true),
        kill: vi.fn(() => true),
        getForegroundProcess: async () => null,
        hasPty: () => false,
        listProcesses: async () => []
      })
      const resolveLegacyWorkerTerminalRecovery = vi.fn()
      runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const firstRecovery = runtime.reconcileLegacyWorkerTerminals()
      await firstDurableWriteStarted.promise
      setSession({ ...getSession(), sleepingAgentSessionsByPaneKey: undefined })
      firstDurableWrite.reject(new Error('disk unavailable'))

      await expect(firstRecovery).resolves.toMatchObject({
        exitedDispatchIds: [],
        deferredDispatchIds: [started.dispatch.id]
      })
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(getSession().sleepingAgentSessionsByPaneKey).toBeUndefined()

      const retry = runtime.reconcileLegacyWorkerTerminals()
      await retryDurableWriteStarted.promise
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      retryDurableWrite.resolve()

      await expect(retry).resolves.toMatchObject({
        exitedDispatchIds: [started.dispatch.id],
        deferredDispatchIds: []
      })
      expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('abandoned')
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        workerPaneKey,
        'rolled_back',
        'pty-missing-retry'
      )
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
      warn.mockRestore()
    } finally {
      db.close()
    }
  })
})
