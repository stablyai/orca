import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'
import { makePendingAgentTabActivationRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('briefly preserves abnormal SSH exits for paired pane recovery', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const runtime = new OrcaRuntimeService(store)
      const ptyId = 'ssh:ssh-1@@pty-recover'
      const tabId = 'host-tab'
      runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
        tabId,
        leafId: HEADLESS_LEAF_ID
      })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: `${tabId}::${HEADLESS_LEAF_ID}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${tabId}::${HEADLESS_LEAF_ID}`,
                parentTabId: tabId,
                leafId: HEADLESS_LEAF_ID,
                ptyId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      runtime.onPtyExit(ptyId, -1)

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 2,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: tabId, status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-with-ssh-pane',
            snapshotVersion: 3,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('briefly preserves an unregistered SSH pane while a restarted HUB rebuilds PTY state', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const runtime = new OrcaRuntimeService(store)
      const ptyId = 'ssh:ssh-1@@pty-restart'
      const tabId = 'host-tab'
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: `${tabId}::${HEADLESS_LEAF_ID}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${tabId}::${HEADLESS_LEAF_ID}`,
                parentTabId: tabId,
                leafId: HEADLESS_LEAF_ID,
                ptyId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 2,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: tabId, status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-restarted-hub',
            snapshotVersion: 3,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrates a persisted SSH-owned pane before an attached renderer publishes its graph', async () => {
    const ptyId = 'ssh:ssh-1@@pty-persisted'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted SSH Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-after-restart',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId,
        status: 'pending-handle'
      })
    ])
  })

  it('hydrates a persisted SSH-owned pane when the restarted renderer has not published sessions', async () => {
    const ptyId = 'ssh:ssh-1@@pty-persisted'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted SSH Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      }
    })
    const localSession = getDefaultWorkspaceSession()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === 'ssh:ssh-1' ? sshSession : localSession
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession
    } as never)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    expect(getWorkspaceSession).toHaveBeenCalledTimes(2)

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId,
        status: 'pending-handle'
      })
    ])
    expect(getWorkspaceSession).toHaveBeenCalledWith('ssh:ssh-1')
  })

  it('publishes a recovered SSH pane when its relay becomes ready after an empty restart replay', async () => {
    const ptyId = 'ssh:ssh-1@@pty-recovered'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Recovered SSH Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      }
    })
    const localSession = getDefaultWorkspaceSession()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession: (hostId?: string | null) =>
        hostId === 'ssh:ssh-1' ? sshSession : localSession
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Recovered SSH Terminal' }
      ]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty-restart',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const reconcile = vi
      .spyOn(runtime, 'reconcileLegacyWorkerTerminals')
      .mockReturnValue(new Promise(() => undefined))

    runtime.notifySshRelayReady('ssh-1')
    await vi.waitFor(() =>
      expect(
        events.some((snapshot) =>
          snapshot.tabs.some(
            (tab) => tab.type === 'terminal' && tab.ptyId === ptyId && tab.status === 'ready'
          )
        )
      ).toBe(true)
    )

    expect(events.at(-1)?.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        ptyId,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
    expect(reconcile).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      materializeRenderer: false
    })
  })

  it('uses only a recent expired SSH lease as a bounded pane-recovery tombstone', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: 'host-tab',
                ptyId: null,
                worktreeId: TEST_WORKTREE_ID,
                title: 'Expired SSH Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
          }
        })
      )
      let leaseState: 'expired' | 'terminated' = 'expired'
      let leaseUpdatedAt = Date.now()
      const getSshRemotePtyLeases = vi.fn(() => [
        {
          targetId: 'ssh-1',
          ptyId: 'pty-expired',
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID,
          state: leaseState,
          createdAt: Date.now() - 1_000,
          updatedAt: leaseUpdatedAt
        }
      ])
      const runtime = new OrcaRuntimeService({
        ...runtimeStore,
        getSshRemotePtyLeases
      } as never)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      })
      const publishEmpty = (snapshotVersion: number): void => {
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [
            {
              worktree: TEST_WORKTREE_ID,
              publicationEpoch: 'renderer-expired-lease',
              snapshotVersion,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          ]
        })
      }

      publishEmpty(1)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
        expect.objectContaining({ parentTabId: 'host-tab', status: 'pending-handle' })
      ])

      vi.advanceTimersByTime(30_001)
      publishEmpty(2)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

      leaseState = 'terminated'
      leaseUpdatedAt = Date.now()
      publishEmpty(3)
      expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not preserve a normally exited SSH shell for pane recovery', async () => {
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'ssh:ssh-1@@pty-normal-exit'
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-normal-exit',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId,
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyExit(ptyId, 0)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-normal-exit',
          snapshotVersion: 2,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('hydrates persisted serve-owned mobile session terminals while a renderer is attached', async () => {
    const focusTerminal = vi.fn()
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-persisted-pty', isReattach: true })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-persisted-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Mobile Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-persisted-pty' })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'serve-persisted-pty',
        status: 'pending-handle'
      })
    ])
    expect(listed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'host-tab',
      tabOrder: ['host-tab']
    })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'serve-persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready'
    })
  })

  it('launches the pending agent when mobile activation materializes an agent tab', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude',
      status: 'pending-handle'
    })

    // Why notifyClients false: mirrors the phone tapping the tab, the path that materializes pending tabs headlessly (#7587).
    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('claude'),
        sessionId: 'serve-dead-pty',
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude',
      status: 'ready'
    })
  })
})
