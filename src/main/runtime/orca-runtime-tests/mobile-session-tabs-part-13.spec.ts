import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  electronMocks,
  ipcMain,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('does not dedupe mobile terminal creates across worktrees with the same clientMutationId', async () => {
    const otherWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [otherWorktreeId]: makeWorktreeMeta({ displayName: 'other' })
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setNotifier({
      focusTerminal: vi.fn(),
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      closeSessionTab: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string; worktreeId: string }) => {
      const parentTabId =
        payload.worktreeId === TEST_WORKTREE_ID ? 'tab-renderer-a' : 'tab-renderer-b'
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: parentTabId, title: 'Terminal' }
      )
    })
    webContents.send = send
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    const firstCreate = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    const secondCreate = runtime.createMobileSessionTerminal(`id:${otherWorktreeId}`, {
      activate: false,
      clientMutationId: 'mutation-1'
    })
    await vi.waitFor(() => {
      const createRequests = send.mock.calls.filter(
        ([channel]) => channel === 'terminal:requestTabCreate'
      )
      expect(createRequests).toHaveLength(2)
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [
        {
          tabId: 'tab-renderer-a',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-renderer-a',
          paneTitle: null
        },
        {
          tabId: 'tab-renderer-b',
          worktreeId: otherWorktreeId,
          leafId: 'pane:1',
          paneRuntimeId: 2,
          ptyId: 'pty-renderer-b',
          paneTitle: null
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-a',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-a::pane:1',
              parentTabId: 'tab-renderer-a',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        },
        {
          worktree: otherWorktreeId,
          publicationEpoch: 'epoch-b',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: null,
          activeTabType: null,
          tabs: [
            {
              type: 'terminal',
              id: 'tab-renderer-b::pane:1',
              parentTabId: 'tab-renderer-b',
              leafId: 'pane:1',
              title: 'Terminal',
              isActive: false
            }
          ]
        }
      ]
    })
    const [first, second] = await Promise.all([firstCreate, secondCreate])

    const createRequests = send.mock.calls.filter(
      ([channel]) => channel === 'terminal:requestTabCreate'
    )
    expect(createRequests).toHaveLength(2)
    expect(first.tab).toMatchObject({ parentTabId: 'tab-renderer-a' })
    expect(second.tab).toMatchObject({ parentTabId: 'tab-renderer-b' })
  })

  it('materializes a renderer-created mobile terminal whose surface stays pending', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '33333333-3333-4333-8333-333333333333'
      const closeTerminal = vi.fn()
      const revealTerminalSession = vi.fn()
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-materialized' })
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'terminal'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(999)

      expect(settled).toBe(false)
      expect(spawn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-pending',
        leafId: pendingLeafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'terminal',
        isActive: true
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          persistHostSessionBinding: true,
          preAllocatedHandle: expect.stringMatching(/^term_/)
        })
      )
      expect(revealTerminalSession).toHaveBeenCalledWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          ptyId: 'pty-materialized',
          tabId: 'tab-pending',
          leafId: pendingLeafId,
          viewMode: 'terminal'
        })
      )
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls back a half-created terminal whose surface never publishes', async () => {
    vi.useFakeTimers()
    try {
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal,
        closeSessionTab: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      // Why: reply with a tabId but never sync a surface graph, so waitForMobileTerminalSurface times out and rollback runs.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-ghost', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const pending = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false
      })
      const settled = pending.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.advanceTimersByTimeAsync(11_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-ghost')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls back a mobile create when the materialize spawn fails and no live PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const pendingLeafId = '99999999-9999-4999-8999-999999999999'
      const closeTerminal = vi.fn()
      // Why: #7587 rescue is gated on a live PTY, not on a mere surface — else this handle-less failed-spawn dead shell would resolve as success.
      const spawn = vi.fn().mockRejectedValue(new Error('spawn failed'))
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-pending', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      const settled = create.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error })
      )
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Only the tab shell publishes (no ptyId → never ready); no PTY ever binds.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-pending',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-pending::${pendingLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-pending::${pendingLeafId}`,
                parentTabId: 'tab-pending',
                leafId: pendingLeafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // Ready-fallback (1s) expires → materialize runs → spawn rejects → catch.
      await vi.advanceTimersByTimeAsync(2_000)
      const outcome = await settled

      expect(outcome.ok).toBe(false)
      expect(closeTerminal).toHaveBeenCalledWith('tab-pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer never publishes the surface', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '44444444-4444-4444-8444-444444444444'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: reply with a tabId but never sync a matching graph, reproducing a renderer that spawns the PTY but stalls graph-sync past the surface timeout (#7587).
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-alive', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true,
        viewMode: 'chat'
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // A shell-only snapshot can win the first race but omit launch props; the later PTY rescue must fill the explicit mode.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-shell',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `tab-alive::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-alive::${leafId}`,
                parentTabId: 'tab-alive',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })

      // The renderer's PTY spawn registers with the tab binding (as the pty IPC layer now does) after the shell-only snapshot.
      runtime.registerPty('pty-alive', TEST_WORKTREE_ID, null, {
        tabId: 'tab-alive',
        leafId
      })

      // Resolves promptly, well under MOBILE_TERMINAL_SURFACE_TIMEOUT_MS (10s).
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-alive',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/),
        viewMode: 'chat'
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer PTY spawn races ahead of the reply', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '55555555-5555-4555-8555-555555555555'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // Why: spawn and tabCreate reply are independent IPC channels; here the PTY registers before the reply, so the pre-wait check resolves it.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        runtime.registerPty('pty-early', TEST_WORKTREE_ID, null, {
          tabId: 'tab-early',
          leafId
        })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-early', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Resolves via the immediate pre-wait rescue, well under the 10s timeout (not the catch path).
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toBe(true)
      const result = await settledCreate

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-early',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers the agent launch command when a create settles over a bare renderer PTY', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: {}
        })
      } as never)
      runtime.setPtyController({
        spawn: vi.fn(),
        write,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        // Why: the pane spawned before its startup queue landed (the #7587
        // renderer-stall class), so no spawn command is recorded for the PTY.
        runtime.registerPty('pty-bare', TEST_WORKTREE_ID, null, { tabId: 'tab-bare', leafId })
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-bare', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await create

      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-bare',
        leafId,
        status: 'ready'
      })
      // Why: the adopted PTY never launched codex, so the settle must type the
      // launch command (Enter as its own write) instead of succeeding silently.
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[0][0]).toBe('pty-bare')
      expect(String(write.mock.calls[0][1])).toMatch(/codex/)
      expect(write.mock.calls[1]).toEqual(['pty-bare', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })
})
