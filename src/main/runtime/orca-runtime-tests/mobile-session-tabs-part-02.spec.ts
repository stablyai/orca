import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('reports the wake as unsupported when a phone activates a worktree on headless serve', async () => {
    // Why: without a renderer nothing holds the sleeping records so nothing wakes; the result must say so or the phone shows slept agents as resumed (#7906).
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const resumeSleepingAgents = vi.fn()
    const getWorkspaceSession = vi.fn(() => ({
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'test',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'worktree-sleep'
        }
      }
    }))
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getWorkspaceSession
    } as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      resumeSleepingAgents,
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    // Headless: graph ready but no BrowserWindow backs the authoritative id, so getAvailableAuthoritativeWindow() is null.
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    expect(result.activated).toBe(true)
    expect(result.sleepingAgentWake).toBe('unsupported-headless')
    // Why: sleeping records are host-partitioned; the check must read the repo's execution host partition, not always the local one.
    expect(getWorkspaceSession).toHaveBeenCalledWith('local')
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
  })

  it('does not report headless wake degradation without sleeping records', async () => {
    const runtime = new OrcaRuntimeService(store as never)
    electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })

    expect(result.sleepingAgentWake).toBe('not-applicable')
  })

  it('does not wake slept agents for non-mobile session-only activation', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false })
    }
    const resumeSleepingAgents = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
    } as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      resumeSleepingAgents,
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    // INV-3: web/desktop runtime clients keep their existing wake-on-activation paths; the renderer notifier wake is mobile-scoped.
    const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'runtime'
    })

    expect(resumeSleepingAgents).not.toHaveBeenCalled()
    expect(result.sleepingAgentWake).toBe('not-applicable')
  })

  it('does not rewrite unread metadata when a mobile activation finds the worktree already read', async () => {
    // Why: seed instanceId so worktree resolution doesn't emit its own metadata-stamp write, isolating the assertion to the unread clear.
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: false, instanceId: 'wt-instance' })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const worktreesChanged = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
    runtime.setNotifier({
      worktreesChanged,
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(worktreesChanged).not.toHaveBeenCalled()

    metaById[TEST_WORKTREE_ID] = makeWorktreeMeta({ isUnread: true, instanceId: 'wt-instance' })
    setWorktreeMeta.mockClear()
    worktreesChanged.mockClear()

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })
    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    expect(setWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { isUnread: false })
    expect(worktreesChanged).toHaveBeenCalledTimes(1)
    expect(worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
  })

  it('returns unread:false from worktree.ps after a mobile activation clears the flag', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ isUnread: true })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)

    const beforeActivation = await runtime.getWorktreePs()
    expect(
      beforeActivation.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
        ?.unread
    ).toBe(true)

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, { notifyClients: false })

    const afterActivation = await runtime.getWorktreePs()
    expect(
      afterActivation.worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)?.unread
    ).toBe(false)
  })

  it('materializes pending mobile session terminals without focusing desktop clients', async () => {
    const persistedPtyId = `${TEST_WORKTREE_ID}@@mobile-only-pty`
    const spawn = vi.fn().mockResolvedValue({ id: persistedPtyId })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: persistedPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: persistedPtyId,
        persistHostSessionBinding: true
      })
    )
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('isNewSession')
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        isActive: true,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('materializes phone-local pending terminal tabs without stored PTY bindings', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'fresh-mobile-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        sessionId: expect.stringMatching(/^serve-/),
        isNewSession: true,
        persistHostSessionBinding: true
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('keeps the target group active when phone-local activation materializes a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'group-target-pty' })
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'host-tab' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Left',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'host-tab-2',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Right',
              customTitle: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined }),
          'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: undefined })
        },
        tabGroups: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'group-left',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'host-tab',
              tabOrder: ['host-tab']
            },
            {
              id: 'group-right',
              worktreeId: TEST_WORKTREE_ID,
              activeTabId: 'host-tab-2',
              tabOrder: ['host-tab-2']
            }
          ]
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab-2',
      HEADLESS_SECOND_LEAF_ID,
      { notifyClients: false }
    )

    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activated.activeGroupId).toBe('group-right')
    expect(activated.tabGroups).toEqual([
      expect.objectContaining({ id: 'group-left', activeTabId: 'host-tab' }),
      expect.objectContaining({ id: 'group-right', activeTabId: 'host-tab-2' })
    ])
    expect(activated.activeTabId).toBe(`host-tab-2::${HEADLESS_SECOND_LEAF_ID}`)
  })

  it('refreshes stale daemon liveness before phone-local terminal materialization', async () => {
    const stalePtyId = `${TEST_WORKTREE_ID}@@stale-mobile-pty`
    const spawn = vi.fn().mockResolvedValue({ id: stalePtyId })
    const listProcesses = vi.fn(async () => [])
    const focusTerminal = vi.fn()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: stalePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: stalePtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.registerPty(stalePtyId, TEST_WORKTREE_ID)
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
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const activated = await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false }
    )

    expect(listProcesses).toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: stalePtyId,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
    )
    expect(activated.tabs).toEqual([
      expect.objectContaining({
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
  })

  it('closes browser mobile session tabs when addressed by browser workspace id', async () => {
    const closeSessionTab = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab,
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'browser-unified-1',
          activeTabType: 'browser',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://example.com/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'browser-workspace-1')

    expect(closeSessionTab).toHaveBeenCalledWith('browser-unified-1', TEST_WORKTREE_ID)
    expect(forgetTabs).toHaveBeenCalledWith(TEST_WORKTREE_ID, ['browser-unified-1'])
  })
})
