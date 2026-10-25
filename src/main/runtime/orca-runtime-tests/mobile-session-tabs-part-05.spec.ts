import { withDurableRuntimeStore } from '../runtime-durable-store-fixture'
import { durableSessionLayoutApply } from '../__fixtures__/main-layout-close-fixture'
import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { committingSpawn, registerLivePty } from '../bind-first-pane.test-fixture'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('uses fresh PTY management titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;claude agents\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents'
      })
    )
    // Stale "working" suppressed; agent identity retained for native chat.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it("publishes the desktop's tab name over the live agent title, and the live title without one", async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'renamed-pty' }))),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'renamed-tab', leafId })
    runtime.attachWindow(1)
    const publish = (
      snapshotVersion: number,
      names: { customTitle: string | null; generatedTitle?: string }
    ) =>
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'renamed-tab',
            worktreeId: TEST_WORKTREE_ID,
            title: '✳ Claude Code',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-renamed',
            snapshotVersion,
            activeGroupId: null,
            activeTabId: `renamed-tab::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `renamed-tab::${leafId}`,
                parentTabId: 'renamed-tab',
                leafId,
                title: '✳ Claude Code',
                ...names,
                isActive: true
              }
            ]
          }
        ]
      })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Switch point: the desktop's tab name is main's own layout, renamed by main's command
      // (#31571), not the window's published row; generated names: orca-runtime-desktop-tab-names.
      const [{ handle }] = (await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals
      await runtime.renameTerminal(handle, 'Build fixer')
      runtime.onPtyData('renamed-pty', '\x1b]0;⠂ Claude Code\x07', 124)
      const named = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(named.tabs[0]).toEqual(expect.objectContaining({ title: 'Build fixer' }))
      await runtime.renameTerminal(handle, null)
      const unnamed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(unnamed.tabs[0]).toEqual(expect.objectContaining({ title: '⠂ Claude Code' }))
      return
    }
    publish(1, { customTitle: 'Build fixer' })
    runtime.onPtyData('renamed-pty', '\x1b]0;⠂ Claude Code\x07', 124)

    const renamed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(renamed.tabs[0]).toEqual(expect.objectContaining({ title: 'Build fixer' }))

    // #30538: a generated name the desktop shows outranks every OSC frame, as it does there.
    publish(2, { customTitle: null, generatedTitle: 'Fix tab titles' })
    const generated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(generated.tabs[0]).toEqual(expect.objectContaining({ title: 'Fix tab titles' }))

    publish(3, { customTitle: null })
    const cleared = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(cleared.tabs[0]).toEqual(expect.objectContaining({ title: '⠂ Claude Code' }))
  })

  it('uses fresh neutral PTY titles over stale mobile snapshot and OSC titles', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = HEADLESS_LEAF_ID
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07', 123)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'laptop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-stale',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `laptop-tab::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `laptop-tab::${leafId}`,
              parentTabId: 'laptop-tab',
              leafId,
              title: 'Claude working',
              agentStatus: {
                state: 'working',
                prompt: 'stale task',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'claude',
                paneKey: `laptop-tab:${leafId}`,
                terminalTitle: 'Claude working',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;zsh\x07', 124)

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'zsh'
      })
    )
    // Stale "working" suppressed; agent identity retained for native chat.
    const suppressed = result.tabs[0]
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.state).toBe('done')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.agentType).toBe('claude')
    expect(suppressed?.type === 'terminal' && suppressed.agentStatus?.terminalTitle).toBeUndefined()
  })

  it('pushes PTY-backed mobile session retirement when a server PTY exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    await runtime.onPtyExit('laptop-created-pty', 0)

    expect(events).toEqual([
      expect.objectContaining({
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      })
    ])
    await expect(runtime.readTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('operates PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal } as never)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })

    await expect(runtime.renameTerminal(laptopTerminal.handle, 'Shared Claude')).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      title: 'Shared Claude'
    })
    await expect(runtime.focusTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      worktreeId: TEST_WORKTREE_ID,
      navigated: false
    })
    await expect(runtime.closeTerminal(laptopTerminal.handle)).resolves.toEqual({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('laptop-created-pty')
    expect(closeTerminal).toHaveBeenCalledWith('laptop-tab')
  })

  it('waits for renderer acknowledgement before returning a whole-tab close receipt', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Durable',
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
    registerLivePty(runtime, 'persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const pending = runtime.closeTerminalTab(terminal.handle)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // #31571: main closes the tab in its own layout, so there is no renderer close to await.
      await expect(pending).resolves.toEqual({
        handle: terminal.handle,
        tabId: 'host-tab',
        closeMode: 'tab',
        ptyKilled: false
      })
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      return
    }
    let settled = false
    void pending.finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    expect(settled).toBe(false)

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({
      handle: terminal.handle,
      tabId: 'host-tab',
      closeMode: 'tab',
      ptyKilled: false
    })
  })

  it('leases renderer publication until a paired whole-tab close is acknowledged', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const setBackgroundThrottling = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Durable',
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
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:paired-close',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId: 'persisted-pty',
              title: 'Durable',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling,
        capturePage: vi.fn(async () => null)
      }
    })

    const pending = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      reason: 'user',
      clientNavigationId: 'device-a'
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // #31571: main commits the close itself, so no renderer close holds a publication lease.
      await expect(pending).resolves.toEqual({ closed: true })
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(setBackgroundThrottling).not.toHaveBeenCalled()
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      return
    }
    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    expect(setBackgroundThrottling.mock.calls).toEqual([[false]])

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    // The final release restores throttling on the next task, after any native destruction.
    await vi.waitFor(() => expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]))
  })

  it('accepts a paired close after the renderer already persisted its removal', async () => {
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const acknowledged = makeDeferred()
    const closeTerminalTab = vi.fn(() => acknowledged.promise)
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() })
    )
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Durable',
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
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:paired-close',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId: 'persisted-pty',
              title: 'Durable',
              isActive: true
            }
          ]
        }
      ]
    })
    runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: vi.fn(),
        capturePage: vi.fn(async () => null)
      }
    })

    const pending = runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      reason: 'user',
      clientNavigationId: 'device-a'
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // #31571: main's own close commits before any renderer could persist a removal.
      await expect(pending).resolves.toEqual({ closed: true })
      expect(kill).toHaveBeenCalledWith('persisted-pty')
      expect(closeTerminalTab).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [TEST_WORKTREE_ID]: [] },
      terminalLayoutsByTabId: {}
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect(kill).toHaveBeenCalledWith('persisted-pty')
  })

  it('reuses pane close for live PTYs that do not own a renderer tab', async () => {
    const kill = vi.fn(() => true)
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'floating-created-pty',
          cwd: TEST_WORKTREE_PATH,
          title: 'Claude'
        }
      ]
    })
    runtime.registerPty('floating-created-pty', TEST_WORKTREE_ID)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: terminal.tabId,
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledWith('floating-created-pty')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('durably closes every split leaf without a renderer', async () => {
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'durable-tab',
              ptyId: null,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Durable',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'durable-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: undefined })
        }
      })
    )
    const flushOrThrow = vi.fn()
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'headless-left' })
      .mockResolvedValueOnce({ id: 'headless-right' })
    const kill = vi.fn(() => true)
    const durableStore = withDurableRuntimeStore({ ...runtimeStore, flushOrThrow })
    // As the Store runs main's `layout.apply`: one durable write.
    const runtime = new OrcaRuntimeService(
      Object.assign(durableStore, {
        applyLayoutCommand: durableSessionLayoutApply(durableStore, {
          get: getSession,
          set: setSession
        })
      })
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'durable-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.splitTerminal(terminal.handle, { direction: 'vertical' })

    await runtime.closeTerminalTab(terminal.handle)

    expect(kill).toHaveBeenCalledWith('headless-left')
    expect(kill).toHaveBeenCalledWith('headless-right')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['durable-tab']).toBeUndefined()
    expect(flushOrThrow).toHaveBeenCalledTimes(1)
  })

  it('lists PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [
        expect.objectContaining({
          handle: laptopTerminal.handle,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Claude working',
          connected: true,
          preview: 'hello'
        })
      ],
      totalCount: 1,
      truncated: false
    })
  })

  it('shows and resolves active PTY-backed mobile session terminals without a renderer graph', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'laptop-created-pty' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const laptopTerminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    runtime.onPtyData('laptop-created-pty', '\x1b]0;Claude working\x07hello\r\n', 123)

    await expect(runtime.resolveActiveTerminal(`id:${TEST_WORKTREE_ID}`)).resolves.toBe(
      laptopTerminal.handle
    )
    await expect(runtime.showTerminal(laptopTerminal.handle)).resolves.toMatchObject({
      handle: laptopTerminal.handle,
      tabId: 'laptop-tab',
      leafId: HEADLESS_LEAF_ID,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Claude working',
      connected: true,
      ptyId: 'laptop-created-pty'
    })
  })
})
