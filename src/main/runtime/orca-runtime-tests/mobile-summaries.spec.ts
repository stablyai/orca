import { makeRuntimeOrchestrationDb } from './runtime-orchestration-db.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { makeAgentStatusStoreWiring } from '../terminal/identity/agent-status-store-wiring.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import {
  HEADLESS_LEAF_ID,
  TEST_FOLDER_WORKSPACE_KEY,
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
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
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
    const publishStaleGraph = async (): Promise<void> => {
      await runtime.syncWindowGraph(1, {
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
    // Another client can republish a pre-sleep graph after physical teardown.
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

  it('attaches inline agent rows from hook-reported status (not just OSC)', async () => {
    // Hook-only agents must appear in worktree.ps without an OSC status.
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
    const orchestrationDb = makeRuntimeOrchestrationDb()
    const run = orchestrationDb.createRun({
      objective: 'Hook summary projection',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const task = orchestrationDb.createTask({
      runId: run.id,
      taskTitle: 'Dispatch prompt work',
      displayName: 'Review dispatch prompts and make worker labels distinct',
      spec: 'Review dispatch prompts\n\nand make worker labels distinct'
    })
    createRootDispatch(orchestrationDb, task.id, workerHandle, paneKey)
    runtime.setOrchestrationDb(orchestrationDb)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
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
    const leafId = '55555555-5555-4555-8555-555555555555'
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
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
        { tabId: 'tab-1', worktreeId: TEST_WORKTREE_ID, leafId, paneRuntimeId: 1, ptyId: 'pty-1' }
      ]
    })
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey: `tab-1:${leafId}`,
      tabId: 'tab-1',
      worktreeId: TEST_WORKTREE_ID,
      connectionId: null,
      payload: {
        state: 'working',
        workingMode: 'monitoring',
        prompt: 'watch tests',
        agentType: 'claude'
      }
    })
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
