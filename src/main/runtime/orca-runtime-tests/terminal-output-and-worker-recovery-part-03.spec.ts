import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, getDefaultWorkspaceSession } from '../orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'
import {
  makePostRevealWorkerRecoveryHarness,
  publishLegacyWorkerReveal
} from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('retries renderer reveal before clearing an adopted legacy worker resume fence', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '44444444-4444-4444-8444-444444444444'
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
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-reveal-retry',
          task_id: 'task-reveal-retry',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_reveal_retry',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-reveal-retry:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_reveal_retry'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-reveal-retry',
      listProcesses: async () => [
        {
          id: 'pty-reveal-retry',
          incarnationId,
          terminalHandle: 'term_reveal_retry',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer unavailable'))
      .mockImplementationOnce(() =>
        publishLegacyWorkerReveal(runtime, {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: HEADLESS_LEAF_ID,
          ptyId: 'pty-reveal-retry'
        })
      )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-reveal-retry'],
      deferredDispatchIds: []
    })
    expect(revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
  })

  it('keeps a revealed worker fenced until its exact renderer graph is published', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => true)
      const identity = {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      }
      harness.revealTerminalSession.mockResolvedValue({
        tabId: identity.tabId,
        identity
      })

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeDefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()

      harness.runtime.attachWindow(1)
      harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            title: 'Post-reveal worker',
            activeLeafId: identity.leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            leafId: identity.leafId,
            paneRuntimeId: 1,
            ptyId: identity.ptyId
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
      expect(
        (await harness.runtime.listTerminals()).terminals.filter(
          (terminal) => terminal.ptyId === identity.ptyId
        )
      ).toEqual([
        expect.objectContaining({
          handle: harness.terminalHandle,
          incarnationId: harness.incarnationId,
          orphaned: false,
          worktreeId: identity.worktreeId,
          tabId: identity.tabId,
          leafId: identity.leafId
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the exact worker when it exits after renderer reveal', async () => {
    const liveProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)
    harness.revealTerminalSession.mockImplementation(() =>
      publishLegacyWorkerReveal(harness.runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      })
    )

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(
      (
        harness.runtime as unknown as {
          ptysById: Map<string, { connected: boolean; incarnationId?: string }>
        }
      ).ptysById.get(harness.ptyId)
    ).toMatchObject({ connected: false, incarnationId: '45454545-4545-4545-8545-454545454545' })
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('re-reveals a recovered worker after the renderer graph epoch changes', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => false)
      harness.runtime.attachWindow(TEST_WINDOW_ID)
      harness.revealTerminalSession
        .mockResolvedValueOnce({
          tabId: 'legacy-post-reveal',
          identity: {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          }
        })
        .mockImplementationOnce(() =>
          publishLegacyWorkerReveal(harness.runtime, {
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'legacy-post-reveal',
            leafId: HEADLESS_LEAF_ID,
            ptyId: harness.ptyId
          })
        )

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      harness.runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [] })
      harness.runtime.markRendererReloading(TEST_WINDOW_ID)
      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-post-reveal'],
        deferredDispatchIds: []
      })

      expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps recovery fenced when the renderer omits the exact reveal identity', async () => {
    const harness = makePostRevealWorkerRecoveryHarness(() => false)
    harness.revealTerminalSession.mockResolvedValue({ tabId: 'legacy-post-reveal' })

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-post-reveal']
    })

    expect(harness.revealTerminalSession).toHaveBeenCalledTimes(2)
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeDefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
  })

  it('reconciles a same-id process replacement before headless adoption', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '56565656-5656-4656-8656-565656565656',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)

    await expect(harness.runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('reconciles a same-id process replacement after renderer materialization', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '67676767-6767-4767-8767-676767676767',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makePostRevealWorkerRecoveryHarness(() => false, listProcesses)
    harness.revealTerminalSession.mockImplementation(() =>
      publishLegacyWorkerReveal(harness.runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      })
    )

    await expect(
      harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(harness.getSession().terminalLayoutsByTabId['legacy-post-reveal']).toBeUndefined()
    const runtimeState = harness.runtime as unknown as {
      tabs: Map<string, unknown>
      leaves: Map<string, unknown>
      ptysById: Map<string, { connected: boolean; incarnationId: string | null }>
    }
    expect(runtimeState.tabs.has('legacy-post-reveal')).toBe(false)
    expect([...runtimeState.leaves.keys()].some((key) => key.includes('legacy-post-reveal'))).toBe(
      false
    )
    expect(runtimeState.ptysById.get(harness.ptyId)).toMatchObject({
      connected: true,
      incarnationId: replacement.incarnationId
    })
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'rolled_back',
      harness.ptyId
    )
    expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      harness.workerPaneKey,
      'exited'
    )
  })

  it('keeps the legacy worker resume fence in memory when persistence fails', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '99999999-9999-4999-8999-999999999999'
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
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        return Promise.resolve()
      }
      durableWriteStarted.resolve()
      return durableWrite.promise
    })
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushPendingOrThrowAsync } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-persistence-failure',
          task_id: 'task-persistence-failure',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_persistence_failure',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-persistence-failure:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_persistence_failure'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-persistence-failure',
      listProcesses: async () => [
        {
          id: 'pty-persistence-failure',
          incarnationId,
          terminalHandle: 'term_persistence_failure',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-persistence-failure'
      })
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const recovery = runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    await durableWriteStarted.promise
    const concurrentPaneKey = `concurrent:${HEADLESS_SECOND_LEAF_ID}`
    setSession({
      ...getSession(),
      sleepingAgentSessionsByPaneKey: {
        ...getSession().sleepingAgentSessionsByPaneKey,
        [concurrentPaneKey]: {
          ...session.sleepingAgentSessionsByPaneKey![workerPaneKey]!,
          paneKey: concurrentPaneKey,
          tabId: 'concurrent-tab'
        }
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(recovery).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-persistence-failure']
    })
    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(getSession().sleepingAgentSessionsByPaneKey?.[concurrentPaneKey]?.tabId).toBe(
      'concurrent-tab'
    )
    expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
