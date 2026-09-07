import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  makePaneKey
} from '../orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from '../orca-runtime-test-fixtures.spec'
import { publishLegacyWorkerReveal } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('recovers exported ORCA_TERMINAL_HANDLE from discovered live PTY sessions', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-1',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_exported'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_exported')

    runtime.onPtyData('pty-1', 'after restart\n', 100)
    await expect(runtime.readTerminal('term_exported')).resolves.toMatchObject({
      handle: 'term_exported',
      tail: ['after restart']
    })
    await expect(
      runtime.sendTerminal('term_exported', { text: 'still writable' })
    ).resolves.toMatchObject({
      handle: 'term_exported',
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('adopts a v1.4.150-shaped agent, setup, and shell orphan as one topology transaction', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const writes: [string, string][] = []
    const resize = vi.fn(() => true)
    const processes = [
      ['pty-agent', 'inc-agent', 'term_agent', 'Agent'],
      ['pty-setup', 'inc-setup', 'term_setup', 'Setup'],
      ['pty-shell', 'inc-shell', 'term_shell', 'Shell']
    ] as const
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    const listProcesses = vi.fn(async () =>
      processes.map(([id, incarnationId, terminalHandle, title]) => ({
        id,
        incarnationId,
        terminalHandle,
        title,
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }))
    )
    runtime.setPtyController({
      write: (ptyId, data) => {
        writes.push([ptyId, data])
        return true
      },
      resize,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(before.terminals.map((terminal) => terminal.tabId)).toEqual(
      processes.map(([id]) => `pty:${id}`)
    )
    const targeted = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`, 100, {
      handles: ['term_setup'],
      requireFreshPtyLiveness: true
    })
    expect(targeted).toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_setup', ptyId: 'pty-setup' })],
      totalCount: 1,
      truncated: false
    })
    runtime.onPtyData('pty-agent', 'legacy output\n', 1)

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'stale-incarnation',
            tabId: 'tab-agent',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      activeTabId: 'tab-agent',
      activeGroupId: 'legacy-group',
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })

    expect(adopted.adopted).toBe(true)
    expect(adopted.topologyRevision).toBe(1)
    expect(adopted.snapshot.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentTabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID,
          title: 'Agent',
          terminal: 'term_agent'
        }),
        expect.objectContaining({
          parentTabId: 'tab-setup',
          leafId: HEADLESS_SECOND_LEAF_ID,
          title: 'Setup',
          terminal: 'term_setup'
        }),
        expect.objectContaining({
          parentTabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID,
          title: 'Shell',
          terminal: 'term_shell'
        })
      ])
    )
    expect(adopted.snapshot.tabGroups).toEqual([
      expect.objectContaining({
        activeTabId: 'tab-agent',
        tabOrder: ['tab-agent', 'tab-setup', 'tab-shell']
      })
    ])
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)

    await runtime.sendTerminal('term_agent', { text: 'input' })
    await runtime.updateRemoteDesktopViewer('pty-agent', 'viewer', 'client', 132, 41)
    expect(writes).toEqual([['pty-agent', 'input']])
    expect(resize).toHaveBeenCalledWith('pty-agent', 132, 41)
    await expect(runtime.readTerminal('term_agent')).resolves.toMatchObject({
      tail: ['legacy output']
    })

    const inventoryCount = listProcesses.mock.calls.length
    const agentPty = (
      runtime as unknown as {
        ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
      }
    ).ptysById.get('pty-agent')!
    agentPty.tabId = null
    agentPty.paneKey = null
    const secondClient = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: processes.map(([ptyId, incarnationId, terminal], index) => ({
        terminal,
        ptyId,
        incarnationId,
        tabId: ['tab-agent', 'tab-setup', 'tab-shell'][index]!,
        leafId: [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID, HEADLESS_THIRD_LEAF_ID][index]!
      }))
    })
    expect(secondClient).toMatchObject({ adopted: false, topologyRevision: 1 })
    expect(agentPty).toMatchObject({
      tabId: 'tab-agent',
      paneKey: makePaneKey('tab-agent', HEADLESS_LEAF_ID)
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 1)
    expect(listProcesses).toHaveBeenLastCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(
      (await runtime.listTerminals()).terminals.find((terminal) => terminal.ptyId === 'pty-agent')
    ).toMatchObject({
      handle: 'term_agent',
      orphaned: false,
      tabId: 'tab-agent',
      leafId: HEADLESS_LEAF_ID
    })
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCount + 2)
    expect(listProcesses).toHaveBeenLastCalledWith(undefined, LIST_PROVIDER_DEADLINE)
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_agent',
            ptyId: 'pty-agent',
            incarnationId: 'inc-agent',
            tabId: 'competing-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('preserves concurrent workspace-session changes when async orphan persistence fails', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      flushPendingOrThrowAsync: vi.fn(() => {
        durableWriteStarted.resolve()
        return durableWrite.promise
      })
    } as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          terminalHandle: 'term_async_rollback',
          title: 'Async rollback',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    const adoption = runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_async_rollback',
          ptyId: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          tabId: 'tab-async-rollback',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })
    await durableWriteStarted.promise
    setSession({
      ...getSession(),
      activeTabIdByWorktree: {
        ...getSession().activeTabIdByWorktree,
        'concurrent-worktree': 'concurrent-tab'
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(adoption).rejects.toThrow('disk unavailable')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['tab-async-rollback']).toBeUndefined()
    expect(getSession().activeTabIdByWorktree?.['concurrent-worktree']).toBe('concurrent-tab')
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID] ?? 0).toBe(0)
  })

  it('does not acknowledge another adoption until the staged owner is durable', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const firstWrite = deferred<void>()
    const firstWriteStarted = deferred<void>()
    let flushCount = 0
    const flushPendingOrThrowAsync = vi.fn(() => {
      flushCount += 1
      if (flushCount === 1) {
        firstWriteStarted.resolve()
        return firstWrite.promise
      }
      return Promise.resolve()
    })
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-serialized-adoption',
        incarnationId: 'inc-serialized-adoption',
        terminalHandle: 'term_serialized_adoption',
        title: 'Serialized adoption',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ])
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      flushPendingOrThrowAsync
    } as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      listProcesses
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const request = {
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_serialized_adoption',
          ptyId: 'pty-serialized-adoption',
          incarnationId: 'inc-serialized-adoption',
          tabId: 'tab-serialized-adoption',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    }

    const first = runtime.adoptTerminalOrphans(request)
    await firstWriteStarted.promise
    const inventoryCountWhileStaged = listProcesses.mock.calls.length
    let secondSettled = false
    const second = runtime.adoptTerminalOrphans(request)
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(secondSettled).toBe(false)
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCountWhileStaged)
    expect(flushPendingOrThrowAsync).toHaveBeenCalledOnce()

    const firstFailure = expect(first).rejects.toThrow('disk unavailable')
    firstWrite.reject(new Error('disk unavailable'))
    await firstFailure
    const adopted = await second

    expect(adopted.adopted).toBe(true)
    expect(listProcesses).toHaveBeenCalledTimes(inventoryCountWhileStaged + 1)
    expect(flushPendingOrThrowAsync).toHaveBeenCalledTimes(2)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'tab-serialized-adoption' })
    ])
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)
  })

  it('fences provider resume and reveals one exact live legacy worker without stealing focus', async () => {
    const workerLeafId = HEADLESS_LEAF_ID
    const coordinatorLeafId = HEADLESS_SECOND_LEAF_ID
    const workerPaneKey = `legacy-worker:${workerLeafId}`
    const incarnationId = '22222222-2222-4222-8222-222222222222'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_WORKTREE_ID,
      activeTabId: 'coordinator',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'coordinator-group' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator',
            ptyId: 'pty-coordinator',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Coordinator',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        coordinator: makeHeadlessTerminalLayout({
          [coordinatorLeafId]: 'pty-coordinator'
        })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'coordinator-group',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'coordinator',
            tabOrder: ['coordinator']
          }
        ]
      },
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
    const flushOrThrow = vi.fn()
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never, undefined, {
      canRecoverPersistentLocalPtys: () => true,
      attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
        paneKey === workerPaneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey, source: 'hydrated_commitment' }
          : null
    })
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: () => undefined,
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-legacy',
          task_id: 'task-legacy',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    const write = vi.fn(() => true)
    const kill = vi.fn(() => true)
    const READY_SCREEN =
      ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n'
    // Why scrollbackRows-aware: a visible-only request gets the grid in `data`;
    // a scrollback request gets history. Collapsing the two would let a test
    // pass on evidence the caller never asked for.
    const serializeProviderBuffer = vi
      .fn()
      .mockImplementation(async (_ptyId: string, opts?: { scrollbackRows?: number }) => ({
        data: opts?.scrollbackRows === 0 ? READY_SCREEN : '',
        scrollbackAnsi: opts?.scrollbackRows === 0 ? '' : READY_SCREEN,
        cols: 80,
        rows: 24,
        seq: 100,
        source: 'headless' as const,
        alternateScreen: false
      }))
    runtime.setPtyController({
      write,
      kill,
      getForegroundProcess: async () => null,
      hasRendererSerializer: () => false,
      serializeProviderBuffer,
      hasPty: (ptyId) => ptyId === 'pty-legacy',
      listProcesses: async () => [
        {
          id: 'pty-legacy',
          incarnationId,
          terminalHandle: 'term_legacy',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(
        runtime,
        {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: workerLeafId,
          ptyId: 'pty-legacy'
        },
        'Legacy worker'
      )
    )
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({
      revealTerminalSession,
      resolveLegacyWorkerTerminalRecovery
    } as never)

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    const recovered = await runtime.reconcileLegacyWorkerTerminals({
      materializeRenderer: true
    })

    expect(recovered).toMatchObject({
      adoptedDispatchIds: ['dispatch-legacy'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().activeTabIdByWorktree?.[TEST_WORKTREE_ID]).toBe('coordinator')
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: 'coordinator',
      tabOrder: ['coordinator', 'legacy-worker']
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-legacy',
      title: 'Legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-worker',
      leafId: workerLeafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_legacy',
        incarnationId
      }
    })
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(workerPaneKey, 'adopted')
    expect(write).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    const [terminal] = (await runtime.listTerminals()).terminals
    await expect(runtime.readTerminal(terminal.handle)).resolves.toMatchObject({
      tail: [' >_ OpenAI Codex (v0.131.0)', ' model:       gpt-5.5 high', ' directory:   /repo']
    })
    expect(serializeProviderBuffer).toHaveBeenCalledWith('pty-legacy', {
      scrollbackRows: 120
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    // Why: the ready banner stays in scrollback for the whole session, so a
    // working grid must not inherit idleness from its own history (#15569 review).
    serializeProviderBuffer.mockResolvedValueOnce({
      data: '  working on it (12s)\r\n  Esc to interrupt\r\n',
      scrollbackAnsi: READY_SCREEN,
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    const lateReadySnapshot = deferred<{
      data: string
      scrollbackAnsi: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
      alternateScreen: boolean
    }>()
    const snapshotSequence = runtime.getPtyOutputSequence('pty-legacy')
    serializeProviderBuffer.mockImplementationOnce(() => lateReadySnapshot.promise)
    const staleReadyWait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 50
    })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledTimes(4))
    runtime.onPtyData('pty-legacy', '\x1b[H', Date.now())
    lateReadySnapshot.resolve({
      data: READY_SCREEN,
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: snapshotSequence,
      source: 'headless',
      alternateScreen: false
    })
    await expect(staleReadyWait).rejects.toThrow('timeout')
    serializeProviderBuffer.mockResolvedValueOnce({
      data: 'Do you trust this workspace directory?\r\n1. Yes\r\n2. No\r\n',
      scrollbackAnsi: '',
      cols: 80,
      rows: 24,
      seq: 101,
      source: 'headless' as const,
      alternateScreen: false
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'codex-trust-workspace'
    })
    serializeProviderBuffer.mockImplementationOnce(() => new Promise(() => {}))
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    // Why args, not counts: the one-shot responses above ignore their options,
    // so only this asserts every idle probe asked for the visible grid alone.
    expect(serializeProviderBuffer.mock.calls.slice(1)).toEqual([
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }],
      ['pty-legacy', { scrollbackRows: 0 }]
    ])
    await expect(runtime.readTerminal(terminal.handle)).resolves.toBeDefined()
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(6)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term_legacy',
        paneKey: workerPaneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN
      })
    ).toMatchObject({
      terminalHandle: 'term_legacy',
      paneKey: workerPaneKey,
      processIncarnation: `pty-legacy:${incarnationId}`
    })

    await runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID]).toBe(1)
    expect(flushOrThrow).toHaveBeenCalled()

    serializeProviderBuffer.mockClear()
    runtime.onPtyExit('pty-legacy', 0, incarnationId)
    runtime.onPtySpawned('pty-legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      awaitsRegistration: false
    })
    const replacementHandle = runtime.createPreAllocatedTerminalHandle()
    runtime.registerPreAllocatedHandleForPty('pty-legacy', replacementHandle)
    await expect(runtime.readTerminal(replacementHandle)).resolves.toMatchObject({ tail: [] })
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })
})
