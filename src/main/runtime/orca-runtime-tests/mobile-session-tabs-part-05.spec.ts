import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { durableSessionLayoutApply } from '../__fixtures__/main-layout-close-fixture'
import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { committingSpawn, registerLivePty } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeDeferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'

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
    await runtime.syncWindowGraph(1, {
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
    await runtime.syncWindowGraph(1, {
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
    await runtime.syncWindowGraph(1, {
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
      await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(setBackgroundThrottling).not.toHaveBeenCalled()
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
      return
    }
    await vi.waitFor(() => expect(closeTerminalTab).toHaveBeenCalledWith('host-tab'))
    expect(setBackgroundThrottling.mock.calls).toEqual([[false]])

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
    // Release restores throttling next task, after native destruction.
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
    await runtime.syncWindowGraph(1, {
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
      await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
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
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
    expect(kill).toHaveBeenCalledWith('persisted-pty')
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
    await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
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

  // Main-owned layouts restore a ready headless graph when the window closes.
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'closes a paired session tab after the desktop window is gone',
    async () => {
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal()
      )
      const closeTerminalTab = vi.fn(async () => undefined)
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
      await runtime.syncWindowGraph(1, {
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

      const closePaired = () =>
        runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
          reason: 'user',
          clientNavigationId: 'device-a'
        })
      runtime.markGraphUnavailable(1)
      runtime.setNotifier(null)
      runtime.attachWindow(2)

      await expect(closePaired()).rejects.toThrow('runtime_unavailable')

      runtime.markGraphUnavailable(2)

      await expect(closePaired()).resolves.toEqual({ closed: true, retirementConfirmed: true })
      expect(closeTerminalTab).not.toHaveBeenCalled()
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).toEqual([])
      expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    }
  )
})
