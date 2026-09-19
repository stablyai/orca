import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

describe('OrcaRuntimeService', () => {
  it('closes a recovered daemon PTY when its session surface is absent', async () => {
    const kill = vi.fn(() => true)
    const rendererError = new Error('tab_not_found')
    const closeTerminal = vi.fn(() => {
      throw rendererError
    })
    const closeTerminalTab = vi.fn(async () => {
      throw new Error('tab_not_found')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.registerPty('recovered-daemon-pty', TEST_WORKTREE_ID, null, {
      tabId: 'recovered-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.closeTerminal(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      tabId: 'recovered-tab',
      ptyKilled: true
    })
    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('recovered-daemon-pty')
    expect(closeTerminal).toHaveBeenCalledWith('recovered-tab')
    expect(warn).toHaveBeenCalledWith(
      '[runtime] failed to notify renderer after headless terminal close',
      { parentTabId: 'recovered-tab', error: rendererError }
    )
  })

  it('stops the exact SSH PTY when its surface vanishes during recovered close', async () => {
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
    let ptyLive = true
    const kill = vi.fn((closedPtyId: string) => {
      ptyLive = false
      runtime.onPtyExit(closedPtyId, 0)
      return true
    })
    runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        ptyLive ? [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Recovered SSH' }] : []
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!terminal || terminal.type !== 'terminal' || !terminal.terminal) {
      throw new Error('Expected a ready SSH terminal')
    }
    const closeMobileSessionTab = vi.spyOn(runtime, 'closeMobileSessionTab')

    await expect(runtime.closeTerminal(terminal.terminal)).resolves.toEqual({
      handle: terminal.terminal,
      tabId: 'host-tab',
      ptyKilled: true
    })

    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(closeMobileSessionTab).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      localPtyTeardownOwnedExternally: true,
      reason: 'user',
      expectedPtyCloseAuthority: {
        handle: terminal.terminal,
        incarnationId: null,
        ptyId,
        worktreeId: TEST_WORKTREE_ID
      }
    })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(ptyId)
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('does not re-kill an externally stopped SSH PTY through raw renderer cleanup', async () => {
    const ptyId = 'ssh:ssh-1@@raw-renderer-cleanup'
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
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Recovered SSH' }]
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

    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(ptyId)
    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeUndefined()
  })

  it('preserves renderer ownership when its close transaction reports a missing tab', async () => {
    const ptyId = `${TEST_WORKTREE_ID}@@renderer-owned`
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Renderer-owned Terminal',
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
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Renderer-owned' }]
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Renderer-owned Terminal',
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
        }
      ]
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const terminal = listed.tabs.find((tab) => tab.type === 'terminal')
    if (!terminal || terminal.type !== 'terminal' || !terminal.terminal) {
      throw new Error('Expected a ready renderer-owned terminal')
    }
    const closeMobileSessionTab = vi
      .spyOn(runtime, 'closeMobileSessionTab')
      .mockRejectedValueOnce(new Error('tab_not_found'))

    await expect(runtime.closeTerminal(terminal.terminal)).rejects.toThrow('tab_not_found')

    expect(closeMobileSessionTab).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      localPtyTeardownOwnedExternally: true
    })
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toHaveLength(1)
    expect(getSession().terminalLayoutsByTabId['host-tab']).toBeDefined()
  })
})
