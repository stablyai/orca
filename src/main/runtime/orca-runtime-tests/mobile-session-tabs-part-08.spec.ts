import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import { makePendingAgentTabActivationRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('materializes a plain shell when the pending tab has no launch agent', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'serve-dead-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
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
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
  })

  it('falls back to a plain shell when the pending tab agent is disabled', async () => {
    const { runtime, spawn } = makePendingAgentTabActivationRuntime({
      disabledTuiAgents: ['claude']
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      { notifyClients: false }
    )

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: TEST_WORKTREE_ID })
    )
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    // Why: the disabled-agent fallback keeps the tab's agent identity; only the startup command is skipped.
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      status: 'ready',
      launchAgent: 'claude'
    })
  })

  it('collapses duplicate mobile terminal entries when renderer and headless leaf ids diverge for the same pty', async () => {
    const rendererLeafId = HEADLESS_SECOND_LEAF_ID
    const ptyId = 'serve-persisted-pty'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
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
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    const rendererSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-graph',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `host-tab::${rendererLeafId}`,
      activeTabType: 'terminal' as const,
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        }
      ],
      tabs: [
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererLeafId,
          ptyId,
          title: 'Persisted Mobile Terminal',
          isActive: true
        }
      ]
    }

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = listed.tabs.filter((tab) => tab.type === 'terminal')

    expect(listed.tabs).toHaveLength(1)
    expect(terminalTabs).toHaveLength(1)
    expect(terminalTabs[0]).toMatchObject({
      type: 'terminal',
      id: `host-tab::${rendererLeafId}`,
      parentTabId: 'host-tab',
      leafId: rendererLeafId,
      ptyId
    })
  })

  it('keeps distinct split mobile terminal ptys under the same parent tab', async () => {
    const rendererLeftLeafId = '33333333-3333-4333-8333-333333333333'
    const rendererRightLeafId = '44444444-4444-4444-8444-444444444444'
    const leftPtyId = 'serve-left'
    const rightPtyId = 'serve-right'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: leftPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Split Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({
            [HEADLESS_LEAF_ID]: leftPtyId,
            [HEADLESS_SECOND_LEAF_ID]: rightPtyId
          })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)
    const rendererSnapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-split-graph',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `host-tab::${rendererLeftLeafId}`,
      activeTabType: 'terminal' as const,
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        }
      ],
      tabs: [
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererLeftLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererLeftLeafId,
          ptyId: leftPtyId,
          title: 'Left',
          isActive: true
        },
        {
          type: 'terminal' as const,
          id: `host-tab::${rendererRightLeafId}`,
          parentTabId: 'host-tab',
          leafId: rendererRightLeafId,
          ptyId: rightPtyId,
          title: 'Right',
          isActive: false
        }
      ]
    }

    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminalTabs = listed.tabs.filter((tab) => tab.type === 'terminal')

    expect(listed.tabs).toHaveLength(2)
    expect(terminalTabs).toHaveLength(2)
    expect(terminalTabs.map((tab) => tab.ptyId).sort()).toEqual([leftPtyId, rightPtyId])
    expect(terminalTabs.map((tab) => tab.leafId).sort()).toEqual(
      [rendererLeftLeafId, rendererRightLeafId].sort()
    )
  })

  it('hydrates legacy persisted terminal tabs without layout entries', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        terminalLayoutsByTabId: {}
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs[0]

    expect(terminal).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      ptyId: 'persisted-pty',
      status: 'pending-handle'
    })
    expect(terminal?.id).toMatch(/^host-tab::[0-9a-f-]{36}$/)
  })

  it('does not mark persisted PTY id collisions ready without matching pane identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'persisted-pty', cwd: TEST_WORKTREE_PATH, title: 'Unrelated PTY' }
      ]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'pending-handle',
      terminal: null
    })
  })

  it('kills persisted SSH PTYs when closing hydrated headless tabs before pane metadata is restored', async () => {
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('durably tears down a runtime-owned SSH headless tab when renderer cleanup fails', async () => {
    // #8958: the renderer relay can't see headless tabs, so its advisory fallback must not block authoritative teardown/flush.
    const persistedPtyId = 'ssh:ssh-1@@relay-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Remote Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: persistedPtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const flushOrThrow = vi.fn()
    const rendererError = new Error('renderer unavailable')
    const closeTerminal = vi.fn(() => {
      throw rendererError
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: persistedPtyId, cwd: TEST_WORKTREE_PATH, title: 'Remote' }]
    })
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(persistedPtyId)
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(flushOrThrow).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[runtime] failed to notify renderer after headless terminal close',
      { parentTabId: 'host-tab', error: rendererError }
    )
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('retires an SSH-owned surface when a stale renderer acknowledges close after relay recovery', async () => {
    const ptyId = 'ssh:ssh-1@@relay-recovered-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
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
    )
    const closeTerminal = vi.fn()
    const closeTerminalTab = vi.fn(async () => {})
    let runtime!: OrcaRuntimeService
    const kill = vi.fn((closedPtyId: string) => {
      runtime.onPtyExit(closedPtyId, 0)
      return true
    })
    runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Recovered SSH Terminal',
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
          ptyId
        },
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_SECOND_LEAF_ID,
          paneRuntimeId: 2,
          ptyId: 'stale-renderer-pty'
        }
      ]
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!terminal || terminal.type !== 'terminal' || !terminal.terminal) {
      throw new Error('Expected a ready SSH terminal')
    }

    await expect(runtime.closeTerminal(terminal.terminal)).resolves.toEqual({
      handle: terminal.terminal,
      tabId: 'host-tab',
      ptyKilled: true
    })

    expect(closeTerminalTab).toHaveBeenCalledWith('host-tab', {
      localPtyTeardownOwnedExternally: true
    })
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('keeps the renderer close transaction for an adopted runtime-owned tab', async () => {
    // The renderer pin state can be newer than the debounced session, so once adopted its live close guard must win over stale persisted metadata.
    const servePtyId = 'serve-adopted-1'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: servePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Adopted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              isPinned: false
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: servePtyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const closeTerminalTab = vi.fn(async () => {
      throw new Error('terminal_tab_pinned')
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: servePtyId, cwd: TEST_WORKTREE_PATH, title: 'Adopted' }]
    })
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Adopted Terminal',
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
          ptyId: servePtyId
        }
      ]
    })

    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')
    ).rejects.toThrow('terminal_tab_pinned')

    expect(closeTerminalTab).toHaveBeenCalledWith('host-tab')
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })

  it('materializes hydrated pending headless terminals with the persisted session identity', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const activated = await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: 'persisted-pty',
        persistHostSessionBinding: true,
        worktreeId: TEST_WORKTREE_ID
      })
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
  })
})
