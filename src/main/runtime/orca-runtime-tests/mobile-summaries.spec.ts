import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, listWorktrees } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resolves files through a source-visible linked-checkout worktree', async () => {
    const linkedPath = '/tmp/linked'
    const scratchPath = `${linkedPath}/.claude/worktrees/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedPath,
        head: 'linked',
        branch: 'feature/linked',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: scratchPath,
        head: 'scratch',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const repo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false,
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show' as const, gsd: 'hide' as const }
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    } as never)

    const target = await (
      runtime as unknown as {
        resolveKnownWorkspaceFileTarget: (
          path: string,
          executionHostId: 'local'
        ) => Promise<{ worktree: { path: string }; relativePath: string } | null>
      }
    ).resolveKnownWorkspaceFileTarget(`${scratchPath}/src/app.ts`, 'local')

    expect(target).toMatchObject({
      worktree: { path: scratchPath },
      relativePath: 'src/app.ts'
    })
  })

  it('applies global custom-source visibility to mobile summaries and file resolution', async () => {
    const globalRoot = '/tmp/global-worktrees'
    const globalWorktreePath = `${globalRoot}/review`
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: globalWorktreePath,
        head: 'review',
        branch: 'feature/review',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const repo = {
      ...store.getRepos()[0],
      externalWorktreeVisibility: 'hide' as const,
      externalWorktreeVisibilityLegacy: false
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo,
      getSettings: () => ({
        ...store.getSettings(),
        worktreeVisibilityDefaults: {
          external: 'hide' as const,
          customSources: [{ id: 'global', rootPath: globalRoot }],
          sourcePreferences: { custom: { global: 'show' as const } }
        }
      })
    } as never)

    const summaries = await runtime.getWorktreePs()
    const target = await (
      runtime as unknown as {
        resolveKnownWorkspaceFileTarget: (
          path: string,
          executionHostId: 'local'
        ) => Promise<{ worktree: { path: string }; relativePath: string } | null>
      }
    ).resolveKnownWorkspaceFileTarget(`${globalWorktreePath}/src/app.ts`, 'local')

    expect(summaries.worktrees.map((worktree) => worktree.path)).toContain(globalWorktreePath)
    expect(target).toMatchObject({
      worktree: { path: globalWorktreePath },
      relativePath: 'src/app.ts'
    })
  })

  it('marks saved session tabs with live PTYs as host sidebar activity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID)
    runtime.onPtyData('persisted-pty', 'ready\n', 456)

    const { worktrees } = await runtime.getWorktreePs()
    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      status: 'active',
      liveTerminalCount: 1
    })
  })

  it('attributes live legacy PTYs from saved layout bindings when their panes are hidden', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          ptyId: null
        }))
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      // Legacy local PTYs have opaque ids and the local provider cannot recover cwd.
      listProcesses: vi.fn(async () => [{ id: 'persisted-pty', cwd: '', title: 'shell' }])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      hasAttachedPty: true,
      liveTerminalCount: 1
    })
  })

  it('prefers migrated layout ownership over a worktree id frozen in the PTY id', async () => {
    const priorWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-before-rename`
    const migratedPtyId = `${priorWorktreeId}@@daemon-controller-pty`
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...session,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          ptyId: null
        }))
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: migratedPtyId })
      }
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      listProcesses: vi.fn(async () => [{ id: migratedPtyId, cwd: '', title: 'shell' }])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true,
      hasAttachedPty: true,
      liveTerminalCount: 1
    })
  })

  it('does not project persisted wake identifiers as live terminal activity', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeIdsOnShutdown: [TEST_WORKTREE_ID]
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null),
      listProcesses: vi.fn(async () => [])
    })

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      status: 'inactive'
    })
  })

  it('projects zero after sleep despite stale renderer leaves and persisted tabs', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const processLists = [
      [{ id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Shell' }],
      [],
      [],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })
    runtime.attachWindow(1)
    const publishStaleGraph = (): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Shell',
            activeLeafId: HEADLESS_LEAF_ID,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'persisted-pty'
          }
        ]
      })
    }
    publishStaleGraph()

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    // Why: another connected client can republish a pre-sleep graph after physical teardown.
    publishStaleGraph()
    const firstObserver = await runtime.getWorktreePs()
    const secondObserver = await runtime.getWorktreePs()

    for (const result of [firstObserver, secondObserver]) {
      expect(result.worktrees[0]).toMatchObject({
        worktreeId: TEST_WORKTREE_ID,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        status: 'inactive'
      })
    }
  })

  it('marks saved browser tabs as host sidebar activity like desktop', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        browserTabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'browser-1',
              worktreeId: TEST_WORKTREE_ID,
              url: 'https://example.com',
              title: 'Example',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()

    expect(worktrees[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      hasHostSidebarActivity: true
    })
  })

  it('falls back to the path-keyed GitHub cache entry', async () => {
    const runtimeStore = {
      ...store,
      getGitHubCache: () => ({
        pr: {
          [`${TEST_REPO_PATH}::feature/foo`]: {
            data: { number: 7, state: 'open' },
            fetchedAt: 1
          }
        },
        issue: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.linkedPR).toEqual({ number: 7, state: 'open' })
  })

  it('includes folder workspaces in compact worktree summaries for mobile', async () => {
    const folderWorkspace = makeFolderWorkspace({
      name: 'GG',
      comment: 'dujiao-next-eval'
    })
    const projectGroup = makeFolderProjectGroup({ name: 'Store' })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )

    const { worktrees } = await runtime.getWorktreePs()
    const folderSummary = worktrees.find(
      (worktree) => worktree.worktreeId === TEST_FOLDER_WORKSPACE_KEY
    )

    expect(folderSummary).toMatchObject({
      workspaceKind: 'folder-workspace',
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      repoId: `folder-workspace:${TEST_FOLDER_PROJECT_GROUP_ID}`,
      repo: 'Store',
      path: TEST_FOLDER_WORKSPACE_PATH,
      branch: '',
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: false,
      displayName: 'GG',
      comment: 'dujiao-next-eval',
      isPinned: false,
      unread: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      status: 'inactive'
    })
  })

  it('attaches inline agent rows from the latest OSC 9999 status', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex","lastAssistantMessage":"on it"}\x07',
      321
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        paneKey: `tab-1:${leafId}`,
        parentPaneKey: null,
        state: 'working',
        agentType: 'codex',
        prompt: 'ship it',
        lastAssistantMessage: 'on it',
        interrupted: false,
        stateStartedAt: expect.any(Number),
        updatedAt: expect.any(Number)
      })
    ])
  })

  it('attaches inline agent rows from hook-reported status (not just OSC)', async () => {
    // Why: agent status arrives via hooks, not OSC; worktree.ps reads the hook snapshot so mobile surfaces those agents.
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = `tab-1:${leafId}`
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'ship it',
          agentType: 'claude',
          lastAssistantMessage: 'on it',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    const workerHandle = runtime.preAllocateHandleForPty('pty-1')
    runtime.setOrchestrationDb({
      getActiveDispatchForTerminal: vi.fn((handle: string) =>
        handle === workerHandle
          ? {
              id: 'ctx-1',
              task_id: 'task-1',
              assignee_handle: workerHandle,
              status: 'dispatched'
            }
          : undefined
      ),
      getLatestDispatchForTerminal: vi.fn(() => undefined),
      getTask: vi.fn(() => ({
        id: 'task-1',
        task_title: 'Dispatch prompt work',
        display_name: 'Review dispatch prompts and make worker labels distinct',
        spec: 'Review dispatch prompts\n\nand make worker labels distinct'
      })),
      getActiveCoordinatorRun: vi.fn(() => undefined)
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        paneKey,
        state: 'working',
        agentType: 'claude',
        prompt: 'ship it',
        taskTitle: 'Dispatch prompt work',
        displayName: 'Review dispatch prompts and make worker labels distinct',
        lastAssistantMessage: 'on it',
        stateStartedAt: now - 100,
        updatedAt: now
      })
    ])
    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
  })

  it('projects monitoring for folder workspaces without assuming a git worktree', async () => {
    const now = Date.now()
    const folderWorkspace = makeFolderWorkspace({ name: 'GG' })
    const projectGroup = makeFolderProjectGroup({ name: 'Store' })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never,
      undefined,
      {
        getAgentStatusSnapshot: () => [
          {
            paneKey: 'folder-pane',
            worktreeId: TEST_FOLDER_WORKSPACE_KEY,
            state: 'working',
            workingMode: 'monitoring',
            prompt: 'watch tests',
            agentType: 'claude',
            connectionId: null,
            receivedAt: now,
            stateStartedAt: now - 100
          }
        ]
      }
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_FOLDER_WORKSPACE_KEY)

    expect(summary).toMatchObject({
      workspaceKind: 'folder-workspace',
      status: 'working',
      workingMode: 'monitoring'
    })
  })
  it('projects monitoring over a title-derived working status', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working', workingMode: 'monitoring' })
  })
  it('keeps hook monitoring mode when a newer mode-less OSC row reports the same work', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now - 100,
          stateStartedAt: now - 200
        }
      ]
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"watch tests","agentType":"claude"}\x07',
      1
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working', workingMode: 'monitoring' })
    expect(summary?.agents).toEqual([
      expect.objectContaining({
        state: 'working',
        workingMode: 'monitoring',
        prompt: 'watch tests'
      })
    ])
  })
  it('does not carry hook monitoring mode into a newer OSC turn', async () => {
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'tab-1:1',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch tests',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now - 100,
          stateStartedAt: now - 200
        }
      ]
    })
    syncSinglePty(runtime)
    runtime.onPtyData(
      'pty-1',
      '\x1b]9999;{"state":"working","prompt":"fix tests","agentType":"claude"}\x07',
      1
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
    expect(summary?.agents).toEqual([
      expect.objectContaining({ state: 'working', prompt: 'fix tests' })
    ])
  })
})
