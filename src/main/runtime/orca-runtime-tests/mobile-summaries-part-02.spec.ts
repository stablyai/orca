import { describe, expect, it, vi } from 'vitest'
import { bindPaneFirst } from '../bind-first-pane.test-fixture'
import { makeAgentStatusStoreWiring } from '../agent-status-store-wiring.test-fixture'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps title-only foreground work ahead of monitoring in another pane', async () => {
    const now = Date.now()
    const monitoringLeafId = '33333333-3333-4333-8333-333333333333'
    const foregroundLeafId = '44444444-4444-4444-8444-444444444444'
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `monitoring-tab:${monitoringLeafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'monitoring-tab',
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
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'monitoring-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: monitoringLeafId,
          layout: null
        },
        {
          tabId: 'foreground-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: foregroundLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'monitoring-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: monitoringLeafId,
          paneRuntimeId: 1,
          ptyId: 'monitoring-pty',
          paneTitle: 'claude'
        },
        {
          tabId: 'foreground-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: foregroundLeafId,
          paneRuntimeId: 2,
          ptyId: 'foreground-pty',
          paneTitle: 'claude working'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey: `monitoring-tab:${monitoringLeafId}` })
    ])
  })
  it('keeps title-only foreground work ahead of monitoring in another split pane', async () => {
    const now = Date.now()
    const tabId = 'split-tab'
    const monitoringLeafId = '33333333-3333-4333-8333-333333333333'
    const foregroundLeafId = '44444444-4444-4444-8444-444444444444'
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `${tabId}:${monitoringLeafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId,
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
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude',
          activeLeafId: monitoringLeafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: monitoringLeafId,
          paneRuntimeId: 1,
          ptyId: 'monitoring-pty',
          paneTitle: 'claude'
        },
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: foregroundLeafId,
          paneRuntimeId: 2,
          ptyId: 'foreground-pty',
          paneTitle: 'claude working'
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ status: 'working' })
    expect(summary).not.toHaveProperty('workingMode')
  })

  it('suppresses restored-unconfirmed hook rows from worktree.ps', async () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `tab-1:${leafId}`,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'may have finished offline',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100,
          restoredUnconfirmed: true
        }
      ]
    })
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
      leaves: []
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: false, status: 'inactive', agents: [] })
  })

  it('uses mirrored tab ownership after a workspace rename instead of stale hook attribution', async () => {
    const renamedPath = '/tmp/worktree-renamed'
    const renamedWorktreeId = `${TEST_REPO_ID}::${renamedPath}`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: renamedPath,
        head: 'def',
        branch: 'feature/renamed',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const metaById = {
      ...store.getAllWorktreeMeta(),
      [renamedWorktreeId]: makeWorktreeMeta({ displayName: 'renamed' })
    }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeId: renamedWorktreeId,
      activeTabIdByWorktree: { [renamedWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [renamedWorktreeId]: [
          {
            id: 'host-tab',
            ptyId: null,
            worktreeId: renamedWorktreeId,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession: () => session
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'continue after rename',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const oldSummary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
    const renamedSummary = worktrees.find((worktree) => worktree.worktreeId === renamedWorktreeId)

    expect(oldSummary?.agents).toEqual([])
    expect(renamedSummary).toMatchObject({
      hasHostSidebarActivity: true,
      status: 'working',
      agents: [expect.objectContaining({ prompt: 'continue after rename' })]
    })
  })

  it('keeps a fresh OSC row when the cached hook row for the same pane is older', async () => {
    const leafId = '44444444-4444-4444-8444-444444444444'
    const paneKey = `tab-1:${leafId}`
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey,
      tabId: 'tab-1',
      worktreeId: TEST_WORKTREE_ID,
      connectionId: null,
      // Keep the agent unchanged to isolate freshness from cross-agent inheritance.
      payload: { state: 'working', prompt: 'earlier hook row', agentType: 'codex' }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
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
      '\x1b]9999;{"state":"working","prompt":"fresh OSC row","agentType":"codex"}\x07',
      321
    )

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey, prompt: 'fresh OSC row', agentType: 'codex' })
    ])
  })

  it.each([
    ['blocked', 0, true, 'permission'],
    ['waiting', 0, true, 'permission'],
    ['done', 0, false, 'inactive'],
    ['working', -AGENT_STATUS_STALE_AFTER_MS - 1, false, 'inactive']
  ] as const)(
    'projects %s agent activity to mobile at freshness offset %s',
    async (state, updatedAtOffset, hasHostSidebarActivity, status) => {
      const now = Date.now()
      const runtime = new OrcaRuntimeService(store, undefined, {
        getAgentStatusSnapshot: () => [
          {
            paneKey: 'tab-1:33333333-3333-4333-8333-333333333333',
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'tab-1',
            state,
            prompt: 'mobile parity',
            agentType: 'codex',
            connectionId: null,
            receivedAt: now + updatedAtOffset,
            stateStartedAt: now - 100
          }
        ]
      })
      // Keep the tab present: this test varies freshness, not the closed-tab filter (#6072).
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            activeLeafId: '33333333-3333-4333-8333-333333333333',
            layout: null
          }
        ],
        leaves: []
      })

      const { worktrees } = await runtime.getWorktreePs()

      const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
      expect(summary).toMatchObject({ hasHostSidebarActivity, status })
      expect(summary?.agents).toHaveLength(1)
    }
  )

  it('drops a hydrated done hook row after its local tab is closed', async () => {
    // Hydrated hook rows for closed tabs must not reappear as current mobile activity (#6072).
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:66666666-6666-4666-8666-666666666666',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'closed-tab',
          state: 'done',
          prompt: 'refactor the parser',
          agentType: 'claude',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary).toMatchObject({
      liveTerminalCount: 0,
      hasHostSidebarActivity: false,
      status: 'inactive',
      agents: []
    })
  })

  it('keeps a hydrated row while its persisted session tab exists and no renderer graph is attached', async () => {
    // Headless session tabs remain current without a renderer graph.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'headless-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'headless-tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'headless-tab',
          state: 'done',
          prompt: 'finished while headless',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ state: 'done', prompt: 'finished while headless' })
    ])
  })

  it('resolves legacy numeric pane keys through the stale filter too', async () => {
    // Non-UUID pane keys without a tabId field must still pass through the closed-tab filter.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'open-tab',
            ptyId: null,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'closed-tab:7',
          worktreeId: TEST_WORKTREE_ID,
          state: 'done',
          prompt: 'stale legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 60_000
        },
        {
          paneKey: 'open-tab:9',
          worktreeId: TEST_WORKTREE_ID,
          state: 'working',
          prompt: 'live legacy pane',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey: 'open-tab:9', prompt: 'live legacy pane' })
    ])
  })

  it('keeps a local hook row while a connected PTY still backs its pane', async () => {
    // A connected daemon PTY proves the pane exists even during graph and session gaps.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const paneKey = 'daemon-tab:77777777-7777-4777-8777-777777777777'
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'daemon-tab',
          state: 'working',
          prompt: 'long-running daemon agent',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'daemon-tab',
      leafId: '77777777-7777-4777-8777-777777777777',
      ptyId: 'daemon-pty'
    })
    // Omit tabId to isolate paneKey rescue.
    runtime['recordPtyWorktree']('daemon-pty', TEST_WORKTREE_ID, {
      connected: true,
      paneKey,
      surfaceRecordedAtGraphSequence: runtime['graphSequence']
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ paneKey, state: 'working', prompt: 'long-running daemon agent' })
    ])
    expect(summary).toMatchObject({ hasHostSidebarActivity: true, status: 'working' })
  })

  it('keeps a local hook row when a connected PTY matches only its tab id', async () => {
    // Use another split leaf to isolate tabId rescue.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const now = Date.now()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'daemon-tab:88888888-8888-4888-8888-888888888887',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'daemon-tab',
          state: 'working',
          prompt: 'sibling pane agent',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now - 100
        }
      ]
    })
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'daemon-tab',
      leafId: '99999999-9999-4999-8999-999999999998',
      ptyId: 'daemon-pty-2'
    })
    runtime['recordPtyWorktree']('daemon-pty-2', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'daemon-tab',
      paneKey: 'daemon-tab:99999999-9999-4999-8999-999999999998',
      surfaceRecordedAtGraphSequence: runtime['graphSequence']
    })

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([
      expect.objectContaining({ prompt: 'sibling pane agent', state: 'working' })
    ])
  })

  it('keeps an OSC row via its connected PTY after the pane binding is cleared', async () => {
    // After controller incarnation changes clear pane coordinates, only the stamped terminal handle can rescue the row.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const runtime = new OrcaRuntimeService(
      runtimeStore as never,
      undefined,
      makeAgentStatusStoreWiring().deps
    )
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'osc-tab',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ptyId: 'osc-pty'
    })
    runtime['recordPtyWorktree']('osc-pty', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'osc-tab',
      paneKey: 'osc-tab:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      surfaceRecordedAtGraphSequence: runtime['graphSequence']
    })
    runtime.onPtyData(
      'osc-pty',
      '\x1b]9999;{"state":"working","prompt":"osc reporter","agentType":"codex"}\x07',
      1
    )
    const pty = runtime['ptysById'].get('osc-pty')!
    pty.tabId = null
    pty.paneKey = null

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'osc reporter' })])
  })

  it('keeps the connected-PTY rescue when a hook row outraces the OSC row for the same pane', async () => {
    // Hooks carry no ptyId; preserve the OSC-observed id when a fresher hook wins.
    const paneKey = 'race-tab:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {}
    })
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, statusWiring.deps)
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'race-tab',
      leafId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ptyId: 'race-pty'
    })
    runtime['recordPtyWorktree']('race-pty', TEST_WORKTREE_ID, {
      connected: true,
      tabId: 'race-tab',
      paneKey,
      surfaceRecordedAtGraphSequence: runtime['graphSequence']
    })
    runtime.onPtyData(
      'race-pty',
      '\x1b]9999;{"state":"working","prompt":"osc ping","agentType":"codex"}\x07',
      1
    )
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey,
      tabId: 'race-tab',
      worktreeId: TEST_WORKTREE_ID,
      connectionId: null,
      payload: { state: 'working', prompt: 'hook-fresh agent', agentType: 'codex' }
    })
    const pty = runtime['ptysById'].get('race-pty')!
    pty.tabId = null
    pty.paneKey = null

    const { worktrees } = await runtime.getWorktreePs()
    const summary = worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)

    expect(summary?.agents).toEqual([expect.objectContaining({ prompt: 'hook-fresh agent' })])
  })
})
