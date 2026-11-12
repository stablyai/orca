import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { describe, expect, it, vi } from 'vitest'
import { bindPaneFirst, registerBoundPty } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { ipcMain } from 'electron'
import { TEST_WORKTREE_ID, createRuntime, deferred, store } from './orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('does not re-deliver the agent launch command when the adopted renderer PTY spawned with one', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '88888888-8888-4888-8888-888888888888'
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
        // Match spawn IPC: command launches record their command just after PTY registration.
        registerBoundPty(runtime, 'pty-carried', TEST_WORKTREE_ID, null, {
          tabId: 'tab-carried',
          leafId
        })
        runtime.noteTerminalSpawnCommand('pty-carried', 'codex')
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-carried', title: 'Terminal' }
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

      expect(result.tab).toMatchObject({ type: 'terminal', parentTabId: 'tab-carried' })
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive when the renderer snapshot is rejected by the version guard', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '66666666-6666-4666-8666-666666666666'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-guard', title: 'Terminal' }
        )
      })
      webContents.send = send
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents
      })
      // Prior renderer frames can leave inflated versions under a stable epoch.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 50,
            activeGroupId: 'group-guard',
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })

      const create = runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex',
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // #7587: renderer lower-version republish is rejected, leaving create stalled until rescue.
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-guard',
            snapshotVersion: 1,
            activeGroupId: 'group-guard',
            activeTabId: `tab-guard::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `tab-guard::${leafId}`,
                parentTabId: 'tab-guard',
                leafId,
                title: 'Terminal',
                isActive: true
              }
            ]
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toBe(false)
      const beforeRescue = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(
        beforeRescue.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-guard')
      ).toBe(false)

      registerBoundPty(runtime, 'pty-guard', TEST_WORKTREE_ID, null, {
        tabId: 'tab-guard',
        leafId
      })
      runtime.noteTerminalSpawnCommand('pty-guard', 'codex')
      await vi.advanceTimersByTimeAsync(50)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-guard',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mobile-created terminal alive at the surface timeout when only a leaf-synced PTY backs the tab', async () => {
    vi.useFakeTimers()
    try {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const closeTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
      // #7587: legacy leaf graph-sync adds identity without registration; only catch-path rescue publishes it.
      const webContents = { send: vi.fn() }
      const send = vi.fn((_channel: string, payload: { requestId: string }) => {
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: webContents },
          { requestId: payload.requestId, tabId: 'tab-catch', title: 'Terminal' }
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
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Park in surface wait before identity arrives.
      await vi.advanceTimersByTimeAsync(50)

      // Main-owned layout ignores window-leaf authority; only registered spawn identity can retain the create.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        registerBoundPty(runtime, 'pty-catch', TEST_WORKTREE_ID, null, {
          tabId: 'tab-catch',
          leafId
        })
        runtime.noteTerminalSpawnCommand('pty-catch', 'codex')
        await vi.advanceTimersByTimeAsync(50)
      }
      // Legacy graph-sync supplies identity without registration rescue, leaving surface unpublished.
      bindPaneFirst(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'tab-catch',
        leafId,
        ptyId: 'pty-catch'
      })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-catch',
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId: 'pty-catch'
          }
        ]
      })

      expect(settled).toBe(ORCA_LAYOUT_OWNER_IS_MAIN)

      // Timeout must rescue the live PTY instead of destructively rolling back the create.
      await vi.advanceTimersByTimeAsync(11_000)
      const result = await settledCreate

      expect(settled).toBe(true)
      expect(result.tab).toMatchObject({
        type: 'terminal',
        parentTabId: 'tab-catch',
        leafId,
        status: 'ready',
        terminal: expect.stringMatching(/^term_/)
      })
      expect(closeTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an in-flight same-connection browser screencast before replacing it', async () => {
    const runtime = createRuntime()
    const firstStart = deferred<{
      subscriptionId: string
      ready: never
      flushPendingFrame: () => void
      session: { stop: () => void; done: Promise<void> }
    }>()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const thirdDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const thirdStop = vi.fn(() => thirdDone.resolve())
    const browserScreencast = vi
      .fn()
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:second',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:third',
        ready: {
          type: 'ready',
          subscriptionId: 'browser-screencast:page-1:third',
          browserPageId: 'page-1',
          format: 'jpeg',
          tab: {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        },
        flushPendingFrame: () => {},
        session: { stop: thirdStop, done: thirdDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const secondEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await Promise.resolve()

    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: secondEmit }
    )
    const thirdEmit = vi.fn()
    const third = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: thirdEmit }
    )
    await Promise.resolve()

    expect(browserScreencast).toHaveBeenCalledTimes(1)

    firstStart.resolve({
      subscriptionId: 'browser-screencast:page-1:first',
      ready: {} as never,
      flushPendingFrame: () => {},
      session: { stop: firstStop, done: firstDone.promise }
    })
    await first
    await Promise.resolve()

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(firstEmit).not.toHaveBeenCalled()
    expect(browserScreencast).toHaveBeenCalledTimes(2)

    await second
    await Promise.resolve()

    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(browserScreencast).toHaveBeenCalledTimes(3)
    expect(thirdEmit).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:third' })
    )

    runtime.cleanupSubscription('browser-screencast:page-1:third')
    await third

    expect(thirdStop).toHaveBeenCalledTimes(1)
  })

  it('keeps same-page screencasts alive for independent connections', async () => {
    const runtime = createRuntime()
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    const ready = (subscriptionId: string) => ({
      type: 'ready' as const,
      subscriptionId,
      browserPageId: 'page-1',
      format: 'jpeg' as const,
      tab: {
        browserPageId: 'page-1',
        index: 0,
        url: 'about:blank',
        title: 'Browser',
        active: true
      }
    })
    const browserScreencast = vi
      .fn()
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:first',
        ready: ready('browser-screencast:page-1:first'),
        flushPendingFrame: () => {},
        session: { stop: firstStop, done: firstDone.promise }
      })
      .mockResolvedValueOnce({
        subscriptionId: 'browser-screencast:page-1:second',
        ready: ready('browser-screencast:page-1:second'),
        flushPendingFrame: () => {},
        session: { stop: secondStop, done: secondDone.promise }
      })

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const firstEmit = vi.fn()
    const first = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary: vi.fn(), emit: firstEmit }
    )
    await vi.waitFor(() =>
      expect(firstEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:first' })
      )
    )

    const secondEmit = vi.fn()
    const second = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-2', sendBinary: vi.fn(), emit: secondEmit }
    )

    await vi.waitFor(() =>
      expect(secondEmit).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'browser-screencast:page-1:second' })
      )
    )
    expect(browserScreencast).toHaveBeenCalledTimes(2)
    expect(firstStop).not.toHaveBeenCalled()

    runtime.cleanupSubscription('browser-screencast:page-1:second')
    await second
    expect(firstStop).not.toHaveBeenCalled()
    expect(secondStop).toHaveBeenCalledTimes(1)
    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await first
    expect(firstStop).toHaveBeenCalledTimes(1)
  })

  it('refuses browser screencast frames before ready and replays them once it is emitted', async () => {
    const runtime = createRuntime()
    const done = deferred<void>()
    const stop = vi.fn(() => done.resolve())
    const startupFrame = new Uint8Array([1, 2, 3])
    const sendBinary = vi.fn()
    const emit = vi.fn()
    let pendingFrame: Uint8Array | null = null
    let gatedSend!: (bytes: Uint8Array) => boolean | void
    const browserScreencast = vi.fn(
      async (_params: unknown, stream: { sendBinary: typeof sendBinary }) => {
        gatedSend = stream.sendBinary
        // Join-time frame arrives before ready; retain it for post-gate replay.
        if (gatedSend(startupFrame) === false) {
          pendingFrame = startupFrame
        }
        expect(sendBinary).not.toHaveBeenCalled()
        return {
          subscriptionId: 'browser-screencast:page-1:first',
          ready: {
            type: 'ready',
            subscriptionId: 'browser-screencast:page-1:first',
            browserPageId: 'page-1',
            format: 'jpeg',
            tab: {
              browserPageId: 'page-1',
              index: 0,
              url: 'about:blank',
              title: 'Browser',
              active: true
            }
          },
          flushPendingFrame: () => {
            const bytes = pendingFrame
            pendingFrame = null
            if (bytes) {
              gatedSend(bytes)
            }
          },
          session: { stop, done: done.promise }
        }
      }
    )

    ;(
      runtime as unknown as { browserCommands: { browserScreencast: typeof browserScreencast } }
    ).browserCommands = { browserScreencast }

    const task = runtime.browserScreencast(
      { worktree: `id:${TEST_WORKTREE_ID}`, page: 'page-1', format: 'jpeg' },
      { connectionId: 'conn-1', sendBinary, emit }
    )

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
    )
    // Idle pages have no next frame; post-ready replay must deliver the refused snapshot.
    expect(sendBinary).toHaveBeenCalledExactlyOnceWith(startupFrame, undefined)

    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await task
  })
})
