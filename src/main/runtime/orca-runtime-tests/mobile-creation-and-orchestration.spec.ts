import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks, ipcMain } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  createRuntime,
  deferred,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../orca-runtime-test-scenario-builders.spec'

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
        // Why: mirrors the spawn IPC handler — a command-carrying spawn records
        // its launch command right after registering the PTY.
        runtime.registerPty('pty-carried', TEST_WORKTREE_ID, null, { tabId: 'tab-carried', leafId })
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
      // Why: seed an inflated stored version under a stable epoch (the state prior renderer publications leave behind).
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
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Renderer republishes with a stale (lower) version under the same epoch, so syncMobileSessionTabs rejects it — the reporter's stall variant (#7587).
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
      // The rejected renderer sync must not have resolved the create.
      expect(settled).toBe(false)
      // Prove the rejection: the stored snapshot still lacks the tab.
      const beforeRescue = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
      expect(
        beforeRescue.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'tab-guard')
      ).toBe(false)

      // The renderer's own PTY spawn registers with the binding and rescues it.
      runtime.registerPty('pty-guard', TEST_WORKTREE_ID, null, {
        tabId: 'tab-guard',
        leafId
      })
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
      // Why (#7587): leaf graph-sync lands identity without registerPty, so only the catch-path rescue saves the stalled live session.
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
        activate: true
      })
      let settled = false
      const settledCreate = create.finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

      // Let the create clear its pre-wait check and park in waitForMobileTerminalSurface before any identity arrives.
      await vi.advanceTimersByTimeAsync(50)

      // Identity arrives via leaf graph-sync, NOT registerPty, so no rescue fires and the surface is never published.
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

      // Surface still unpublished, so the create is still pending.
      expect(settled).toBe(false)

      // Cross the 10s surface timeout: the catch path must rescue from the live PTY, not roll the session back destructively.
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

  it('reports browser tab creation as unsupported for a windowless host with no offscreen backend', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('does not support browser panes')
    })
  })

  it('creates a browser tab via the offscreen backend for a headless runtime server', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const createTab = vi.fn(async () => ({ browserPageId: 'page-headless' }))
    runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn() })

    await expect(
      runtime.browserTabCreate({ worktree: `id:${TEST_WORKTREE_ID}`, url: 'https://example.com' })
    ).resolves.toEqual({ browserPageId: 'page-headless' })
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }))
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

  it('dedupes async subscription cleanup and retains a failed cleanup for retry', async () => {
    const runtime = createRuntime()
    const cleanupError = new Error('physical teardown incomplete')
    const firstCleanup = deferred<void>()
    const cleanup = vi
      .fn()
      .mockReturnValueOnce(firstCleanup.promise)
      .mockRejectedValue(cleanupError)
    runtime.registerSubscriptionCleanup('files-watch-1', cleanup, 'conn-1')

    const first = runtime.cleanupSubscriptionAndWait('files-watch-1')
    const duplicate = runtime.cleanupSubscriptionAndWait('files-watch-1')
    expect(cleanup).toHaveBeenCalledTimes(1)
    firstCleanup.reject(cleanupError)
    await expect(first).rejects.toBe(cleanupError)
    await expect(duplicate).rejects.toBe(cleanupError)

    await expect(runtime.cleanupSubscriptionAndWait('files-watch-1')).rejects.toBe(cleanupError)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('does not let an old connection cleanup tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const oldDone = deferred<void>()
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:stable', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:stable', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    runtime.cleanupSubscriptionsForConnection('conn-old')
    expect(replacementCleanup).not.toHaveBeenCalled()

    runtime.cleanupSubscriptionsForConnection('conn-new')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
    oldDone.resolve()
    await Promise.resolve()
  })

  it('does not let a delayed cleanup retry tear down its replacement subscription', async () => {
    const runtime = createRuntime()
    const physicalExit = deferred<void>()
    const oldDone = deferred<void>()
    const cleanupError = new Error('physical teardown incomplete')
    const oldCleanup = vi.fn(() => oldDone.promise)
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('files-watch:stable', oldCleanup, 'conn-old')
    const oldAttempt = runtime.cleanupSubscriptionAndWait('files-watch:stable')
    runtime.retrySubscriptionCleanupAfter('files-watch:stable', oldCleanup, physicalExit.promise)
    runtime.registerSubscriptionCleanup('files-watch:stable', replacementCleanup, 'conn-new')

    oldDone.reject(cleanupError)
    await expect(oldAttempt).rejects.toBe(cleanupError)
    physicalExit.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(oldCleanup).toHaveBeenCalledTimes(1)
    expect(replacementCleanup).not.toHaveBeenCalled()
    await runtime.cleanupSubscriptionAndWait('files-watch:stable')
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('releases an owned subscription only while its registration still owns the id', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    const oldRegistration = runtime.registerOwnedSubscriptionCleanup(
      'terminal:owned',
      oldCleanup,
      'conn-old'
    )

    runtime.registerOwnedSubscriptionCleanup('terminal:owned', replacementCleanup, 'conn-new')
    expect(oldCleanup).toHaveBeenCalledTimes(1)

    // The stale registration must not reach the replacement that now owns the id.
    oldRegistration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()
  })

  it('releases an owned subscription when the registration is still current', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    const registration = runtime.registerOwnedSubscriptionCleanup('terminal:live', cleanup, 'conn')
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
    // A second release is a no-op: the registration no longer owns the id.
    registration.releaseIfCurrent()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses an unsubscribe from a connection that no longer owns the subscription', async () => {
    const runtime = createRuntime()
    const oldCleanup = vi.fn()
    const replacementCleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:unsub', oldCleanup, 'conn-old')
    runtime.registerSubscriptionCleanup('terminal:unsub', replacementCleanup, 'conn-new')

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-old')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).not.toHaveBeenCalled()

    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:unsub', 'conn-new')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
  })

  it('reports an unregistered subscription as gone rather than refused', async () => {
    const runtime = createRuntime()

    // Why it matters: a client retrying on `false` would otherwise chase a dead id.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:missing', 'conn-a')).toBe(true)
  })

  it('reports a refusal even when a sibling id was merely absent', async () => {
    const runtime = createRuntime()
    const bareCleanup = vi.fn()
    const compositeCleanup = vi.fn()

    // A clientless stream registers under the bare id; a client-scoped one under the composite.
    runtime.registerSubscriptionCleanup('terminal-1', bareCleanup, 'conn-a')
    runtime.registerSubscriptionCleanup('terminal-1:phone-1', compositeCleanup, 'conn-b')

    // conn-a owns the bare id but not the composite: one genuine teardown, one refusal.
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1', 'conn-a')).toBe(true)
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal-1:phone-1', 'conn-a')).toBe(
      false
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bareCleanup).toHaveBeenCalledTimes(1)
    expect(compositeCleanup).not.toHaveBeenCalled()
  })

  // Why: the lease-only branch's unguarded compensating handleMobileUnsubscribe is only
  // safe while a viewport-less subscribe cannot yield to the macrotask queue. Pin it so
  // adding an await to that path fails here instead of silently killing a live lease.
  it('settles a viewport-less mobile subscribe without leaving the microtask queue', async () => {
    const runtime = createRuntime()
    let settled = false

    void runtime.handleMobileSubscribe('pty-lease', 'phone-1', undefined).then(() => {
      settled = true
    })
    // Drain microtasks only: any real await on this path leaves this unsettled.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve()
    }

    expect(settled).toBe(true)
  })

  it('tears down unconditionally for in-process callers that have no connection', async () => {
    const runtime = createRuntime()
    const cleanup = vi.fn()

    runtime.registerSubscriptionCleanup('terminal:inproc', cleanup, 'conn-owner')
    expect(runtime.cleanupSubscriptionIfOwnedByConnection('terminal:inproc', undefined)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cleanup).toHaveBeenCalledTimes(1)
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
        // Why: a joining subscriber's viewport snapshot is captured here, before the caller
        // has emitted ready, so the fan-out retains what the gate refuses.
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
    // The gate still refuses the frame on arrival; it reaches the client only via the
    // post-ready replay, so a static page does not leave the subscriber frameless.
    expect(sendBinary).toHaveBeenCalledExactlyOnceWith(startupFrame)

    runtime.cleanupSubscription('browser-screencast:page-1:first')
    await task
  })
})
