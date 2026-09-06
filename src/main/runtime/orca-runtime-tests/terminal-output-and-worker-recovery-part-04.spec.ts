import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  OrchestrationDb,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from '../orca-runtime-test-fixtures.spec'
import { publishLegacyWorkerReveal } from '../orca-runtime-test-scenario-builders.spec'

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
      { ...runtimeStore, flushOrThrow, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'continue after missing worker recovery' })
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
      { ...runtimeStore, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'retry missing worker recovery' })
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

  it('retires provider resume only after authoritative inventory proves the legacy PTY exited', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const secondWorkerPaneKey = `legacy-worker-two:${HEADLESS_SECOND_LEAF_ID}`
    const incarnationId = '33333333-3333-4333-8333-333333333333'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        },
        [secondWorkerPaneKey]: {
          paneKey: secondWorkerPaneKey,
          tabId: 'legacy-worker-two',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session-two' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-exited',
          task_id: 'task-exited',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_exited',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-exited:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_exited'
        },
        {
          dispatch_id: 'dispatch-exited-two',
          task_id: 'task-exited-two',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_exited_two',
          assignee_pane_key: secondWorkerPaneKey,
          process_incarnation: `pty-exited-two:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_exited_two'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async (connectionId?: string | null) => {
      if (connectionId !== null) {
        throw new Error('unrelated SSH inventory must not run')
      }
      return [
        {
          id: 'pty-exited-two',
          incarnationId,
          terminalHandle: 'term_exited_two',
          title: 'Exited worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: () => false,
      listProcesses
    })
    const revealTerminalSession = vi.fn()
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-exited-two'],
      exitedDispatchIds: ['dispatch-exited'],
      deferredDispatchIds: []
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[secondWorkerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'legacy-worker-two', ptyId: 'pty-exited-two' })
    ])
    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(
      (
        runtime as unknown as {
          ptysById: Map<string, { connected: boolean }>
        }
      ).ptysById.get('pty-exited-two')
    ).toMatchObject({ connected: true })
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'exited')
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(secondWorkerPaneKey, 'adopted')
  })

  it('retries inventory and unknown liveness without revealing a ghost worker', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '55555555-5555-4555-8555-555555555555'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-inventory-unavailable',
          task_id: 'task-inventory-unavailable',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_inventory_unavailable',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-inventory-unavailable:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_inventory_unavailable'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('local provider unavailable'))
      .mockResolvedValue([
        {
          id: 'pty-inventory-unavailable',
          incarnationId,
          terminalHandle: 'term_inventory_unavailable',
          title: 'Recovered legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ])
    const hasPty = vi.fn().mockReturnValueOnce(null).mockReturnValue(true)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty,
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-inventory-unavailable'
      })
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    vi.useFakeTimers()
    try {
      await expect(
        runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-inventory-unavailable']
      })
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
      expect(listProcesses).toHaveBeenCalledOnce()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(revealTerminalSession).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)

      expect(listProcesses).toHaveBeenCalledTimes(4)
      expect(listProcesses.mock.calls.map((call) => call[0])).toEqual([null, null, null, null])
      expect(hasPty).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
        expect.objectContaining({ id: 'legacy-worker', ptyId: 'pty-inventory-unavailable' })
      ])
      expect(revealTerminalSession).toHaveBeenCalledOnce()
      expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(listProcesses).toHaveBeenCalledTimes(4)
      expect(revealTerminalSession).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a coalesced SSH worker recovery retry when its provider disconnects', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const reconcile = vi.spyOn(runtime, 'reconcileLegacyWorkerTerminals').mockResolvedValue({
        blockedPaneCount: 1,
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
      const retryInternals = runtime as unknown as {
        updateLegacyWorkerTerminalRecoveryRetry: (
          plan: {
            candidates: { dispatchId: string; ptyId: string }[]
          },
          deferredDispatchIds: ReadonlySet<string>,
          options: { connectionId?: string; materializeRenderer?: boolean }
        ) => void
      }
      const plan = {
        candidates: [
          {
            dispatchId: 'dispatch-ssh-retry',
            ptyId: 'ssh:ssh-retry@@pty-worker'
          }
        ]
      }
      const deferred = new Set(['dispatch-ssh-retry'])

      retryInternals.updateLegacyWorkerTerminalRecoveryRetry(plan, deferred, {
        connectionId: 'ssh-retry',
        materializeRenderer: true
      })
      retryInternals.updateLegacyWorkerTerminalRecoveryRetry(plan, deferred, {
        connectionId: 'ssh-retry',
        materializeRenderer: true
      })
      runtime.notifySshStateChanged('ssh-retry', {
        targetId: 'ssh-retry',
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(reconcile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
