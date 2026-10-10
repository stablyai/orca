import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  assertWorktreeCleanForRemoval,
  electronMocks,
  ipcMain,
  listWorktrees,
  removeWorktree
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  describe('browser page targeting', () => {
    function mockLiveBrowserGuest(): void {
      electronMocks.webContents.fromId.mockReturnValue({
        isDestroyed: () => false
      })
    }

    it('passes explicit page ids through without resolving the current worktree', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      const result = await runtime.browserSnapshot({ page: 'page-1' })

      expect(result.browserPageId).toBe('page-1')
      expect(snapshotMock).toHaveBeenCalledWith(undefined, 'page-1')
      expect(listWorktrees).not.toHaveBeenCalled()
    })

    it('resolves explicit worktree selectors when page ids are also provided', async () => {
      vi.mocked(listWorktrees).mockClear()
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn().mockResolvedValue({
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      })

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await runtime.browserSnapshot({
        worktree: 'branch:feature/foo',
        page: 'page-1'
      })

      expect(snapshotMock).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'page-1')
    })

    it('routes tab switch and capture start by explicit page id', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 2,
        browserPageId: 'page-2'
      })
      const captureStartMock = vi.fn().mockResolvedValue({
        capturing: true
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        captureStart: captureStartMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-2', 2]])),
        tabList: vi.fn(() => ({
          tabs: [
            { browserPageId: 'page-0', index: 0, url: 'about:blank', title: '', active: false },
            { browserPageId: 'page-1', index: 1, url: 'about:blank', title: '', active: false },
            { browserPageId: 'page-2', index: 2, url: 'about:blank', title: '', active: true }
          ]
        }))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-2' })).resolves.toEqual({
        switched: 2,
        browserPageId: 'page-2'
      })
      await expect(runtime.browserCaptureStart({ page: 'page-2' })).resolves.toEqual({
        capturing: true
      })
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-2')
      expect(captureStartMock).toHaveBeenCalledWith(undefined, 'page-2')
    })

    it('accepts focus on tab switch without altering bridge args (focus is main-side concern)', async () => {
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const tabSwitchMock = vi.fn().mockResolvedValue({
        switched: 0,
        browserPageId: 'page-1'
      })

      runtime.setAgentBrowserBridge({
        tabSwitch: tabSwitchMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
        tabList: vi.fn(() => ({
          tabs: [{ browserPageId: 'page-1', index: 0, url: 'about:blank', title: '', active: true }]
        }))
      } as never)

      await expect(runtime.browserTabSwitch({ page: 'page-1', focus: true })).resolves.toEqual({
        switched: 0,
        browserPageId: 'page-1'
      })
      // Bridge is unchanged — focus is delivered to the renderer via IPC, not threaded through bridge state.
      expect(tabSwitchMock).toHaveBeenCalledWith(undefined, undefined, 'page-1')
    })

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn()

      runtime.setAgentBrowserBridge({
        snapshot: snapshotMock,
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserSnapshot({
          worktree: 'path:/tmp/missing-worktree',
          page: 'page-1'
        })
      ).rejects.toThrow('selector_not_found')
      expect(snapshotMock).not.toHaveBeenCalled()
    })

    it('does not silently drop invalid explicit worktree selectors for non-page browser commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      const runtime = createRuntime()
      const tabListMock = vi.fn()

      runtime.setAgentBrowserBridge({
        tabList: tabListMock
      } as never)

      await expect(
        runtime.browserTabList({
          worktree: 'path:/tmp/missing-worktree'
        })
      ).rejects.toThrow('selector_not_found')
      expect(tabListMock).not.toHaveBeenCalled()
    })

    it('rejects closing an unknown page id instead of treating it as success', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]]))
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'missing-page'
        })
      ).rejects.toThrow('Browser page missing-page was not found')
    })

    it('rejects closing a page outside the explicitly scoped worktree', async () => {
      mockLiveBrowserGuest()
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
      const runtime = createRuntime()
      const getRegisteredTabsMock = vi.fn((worktreeId?: string) =>
        worktreeId === `${TEST_REPO_ID}::/tmp/worktree-b` ? new Map() : new Map([['page-1', 1]])
      )

      runtime.setAgentBrowserBridge({
        getRegisteredTabs: getRegisteredTabsMock
      } as never)

      await expect(
        runtime.browserTabClose({
          page: 'page-1',
          worktree: 'path:/tmp/worktree-b'
        })
      ).rejects.toThrow('Browser page page-1 was not found in this worktree')
      expect(getRegisteredTabsMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/tmp/worktree-b`)
    })
  })

  describe('removeManagedWorktree PTY teardown (design §4.3)', () => {
    function createProviderStub(
      listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
    ): {
      spawn: ReturnType<typeof vi.fn>
      attach: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      resize: ReturnType<typeof vi.fn>
      shutdown: ReturnType<typeof vi.fn>
      sendSignal: ReturnType<typeof vi.fn>
      getCwd: ReturnType<typeof vi.fn>
      getInitialCwd: ReturnType<typeof vi.fn>
      clearBuffer: ReturnType<typeof vi.fn>
      acknowledgeDataEvent: ReturnType<typeof vi.fn>
      hasChildProcesses: ReturnType<typeof vi.fn>
      getForegroundProcess: ReturnType<typeof vi.fn>
      serialize: ReturnType<typeof vi.fn>
      revive: ReturnType<typeof vi.fn>
      listProcesses: ReturnType<typeof vi.fn>
      getDefaultShell: ReturnType<typeof vi.fn>
      getProfiles: ReturnType<typeof vi.fn>
      onData: ReturnType<typeof vi.fn>
      onReplay: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
    } {
      return {
        spawn: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent: vi.fn(),
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn(),
        onData: vi.fn().mockReturnValue(() => {}),
        onReplay: vi.fn().mockReturnValue(() => {}),
        onExit: vi.fn().mockReturnValue(() => {})
      }
    }

    it('RPC-initiated delete awaits matching PTYs before git', async () => {
      // Seed the runtime with a live leaf whose worktreeId matches the target.
      const callOrder: string[] = []
      const stopAndWait = vi.fn(async (id: string) => {
        callOrder.push(`stop-and-wait:${id}`)
        return true
      })
      const localProvider = createProviderStub(async () => [])
      vi.mocked(assertWorktreeCleanForRemoval).mockImplementation(async () => {
        callOrder.push('preflight')
      })
      vi.mocked(removeWorktree).mockImplementation(async () => {
        callOrder.push('git-removeWorktree')
        return {}
      })

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => {
          callOrder.push('getLocalProvider')
          return localProvider as never
        }
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait,
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // Destructive teardown must bound the underlying RPCs below the sweep deadline.
      expect(stopAndWait).toHaveBeenCalledWith(
        'pty-1',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
      // The provider-prefix sweep and the git removal must happen AFTER the
      // runtime-graph physical stop. Git removal must NOT start before it.
      const preflightIdx = callOrder.indexOf('preflight')
      const stopIdx = callOrder.indexOf('stop-and-wait:pty-1')
      const gitIdx = callOrder.indexOf('git-removeWorktree')
      expect(preflightIdx).toBeGreaterThanOrEqual(0)
      expect(stopIdx).toBeGreaterThan(preflightIdx)
      expect(stopIdx).toBeGreaterThanOrEqual(0)
      expect(gitIdx).toBeGreaterThan(stopIdx)
    })

    it('does not start Git removal when physical PTY stop cannot be proven', async () => {
      // A failed stop only rejects when a fresh inventory still shows the PTY
      // live; keep pty-1 present so the exit cannot be proven.
      const localProvider = createProviderStub(async () => [
        { id: 'pty-1', cwd: '/tmp', title: 'shell' }
      ])
      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => localProvider as never
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait: vi.fn(async () => false),
        getForegroundProcess: async () => null
      })
      syncSinglePty(runtime, 'pty-1')

      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
        'Failed to physically stop every PTY'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
    })

    it('thunk resolves the installed provider lazily, not at construction time', async () => {
      // Simulates the daemon adapter being installed AFTER construction; a capture-at-construction refactor would break this.
      const preDaemonProvider = createProviderStub(async () => [
        { id: '1', cwd: '/tmp', title: 'shell' },
        { id: '2', cwd: '/tmp', title: 'shell' }
      ])
      const postDaemonProvider = createProviderStub(async () => [
        { id: `${TEST_WORKTREE_ID}@@aaaaaaaa`, cwd: '/tmp', title: 'shell' }
      ])
      let currentProvider: ReturnType<typeof createProviderStub> = preDaemonProvider
      const onPtyStopped = vi.fn()

      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => currentProvider as never,
        onPtyStopped
      })
      vi.mocked(removeWorktree).mockResolvedValue({})

      // Simulate daemon-init swapping the provider after construction.
      currentProvider = postDaemonProvider

      await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

      // The post-daemon provider's prefix-matching session must have been
      // shut down, proving the thunk resolved lazily at call time.
      expect(postDaemonProvider.shutdown).toHaveBeenCalledWith(
        `${TEST_WORKTREE_ID}@@aaaaaaaa`,
        expect.objectContaining({ immediate: true })
      )
      expect(onPtyStopped).toHaveBeenCalledWith(`${TEST_WORKTREE_ID}@@aaaaaaaa`)
      // The pre-daemon provider must not have been consulted for the kill.
      expect(preDaemonProvider.shutdown).not.toHaveBeenCalled()
    })
  })
  describe('stale terminal handle resolution (#7718)', () => {
    function syncSingleTerminalGraph(runtime: OrcaRuntimeService, ptyId: string): void {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId,
            paneTitle: 'Terminal 1'
          }
        ],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal 1',
                isActive: true
              }
            ]
          }
        ]
      })
    }

    // Why: client-created terminals (terminal.create) hold LEAF handles that can diverge from the pane's current PTY across reconnects.
    function issueLeafHandle(runtime: OrcaRuntimeService, ptyId: string): string {
      const internals = runtime as unknown as {
        leaves: Map<string, { ptyId: string | null }>
        issueHandle: (leaf: unknown) => string
      }
      const leaf = Array.from(internals.leaves.values()).find(
        (candidate) => candidate.ptyId === ptyId
      )
      if (!leaf) {
        throw new Error('expected leaf record')
      }
      return internals.issueHandle(leaf)
    }

    it('errors with terminal_handle_stale instead of adopting a replacement PTY', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')

      // Simulate the pane's PTY being replaced while the remote client still holds the old handle.
      const internals = runtime as unknown as {
        leaves: Map<string, { ptyId: string | null }>
      }
      for (const leaf of internals.leaves.values()) {
        if (leaf.ptyId === 'pty-a') {
          leaf.ptyId = 'pty-b'
        }
      }

      // The unguarded resolver silently adopts the new PTY — the misroute.
      expect(runtime.resolveLeafForHandle(handle)).toEqual({ ptyId: 'pty-b' })
      // The guarded resolver surfaces the staleness so clients can re-derive.
      expect(() => runtime.resolveLiveLeafForHandle(handle)).toThrow('terminal_handle_stale')
      expect(runtime.getLiveTerminalPaneKey(handle)).toBeNull()
    })

    it('lets a handle issued before its first PTY adopt that PTY without erroring', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')

      // Simulate the mobile pre-spawn flow: the handle record predates the PTY (ptyId null); its first PTY must still resolve.
      const internals = runtime as unknown as {
        handles: Map<string, { ptyId: string | null }>
      }
      const record = internals.handles.get(handle)
      if (!record) {
        throw new Error('expected handle record')
      }
      record.ptyId = null

      expect(runtime.resolveLiveLeafForHandle(handle)).toEqual({ ptyId: 'pty-a' })
    })

    it('keeps terminal cwd resolution fail-soft when the provider is unavailable', async () => {
      const runtime = new OrcaRuntimeService(store)
      runtime.attachWindow(1)
      syncSingleTerminalGraph(runtime, 'pty-a')
      const handle = issueLeafHandle(runtime, 'pty-a')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        getCwd: async () => {
          throw new Error('ssh disconnected')
        }
      })

      await expect(runtime.resolveTerminalCwd(handle)).resolves.toBeNull()
    })
  })

  describe('mobile terminal create resilience (#7718)', () => {
    it('cancels the surface wait without rolling back when the client connection dies', async () => {
      vi.useFakeTimers()
      try {
        const closeTerminal = vi.fn()
        const runtime = new OrcaRuntimeService(store)
        runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
        const abort = new AbortController()
        const webContents = { send: vi.fn() }
        const send = vi.fn((_channel: string, payload: { requestId: string }) => {
          ipcMain.emit(
            'terminal:tabCreateReply',
            { sender: webContents },
            { requestId: payload.requestId, tabId: 'tab-abort', title: 'Terminal' }
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
          activate: false,
          signal: abort.signal
        })
        const settled = create.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

        // Client socket dies mid-wait: create must settle right away (not the 10s timeout) and must NOT close the tab (real terminal exists).
        abort.abort()
        await vi.advanceTimersByTimeAsync(0)
        const outcome = await settled

        expect(outcome.ok).toBe(false)
        if (outcome.ok === false) {
          expect(outcome.error.message).toBe('client_disconnected')
        }
        expect(closeTerminal).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a mobile-created terminal alive when its live shell has no registered pane key', async () => {
      vi.useFakeTimers()
      try {
        const closeTerminal = vi.fn()
        const runtime = new OrcaRuntimeService(store)
        runtime.setNotifier(createMobileCreateTestNotifier(closeTerminal))
        const webContents = { send: vi.fn() }
        const send = vi.fn((_channel: string, payload: { requestId: string }) => {
          ipcMain.emit(
            'terminal:tabCreateReply',
            { sender: webContents },
            { requestId: payload.requestId, tabId: 'tab-stall', title: 'Terminal' }
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
          activate: false
        })
        const settled = create.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

        // A live shell backs the tab but its leaf id isn't a terminal UUID, so no pane key registers (stalled renderer publication).
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [
            {
              tabId: 'tab-stall',
              worktreeId: TEST_WORKTREE_ID,
              leafId: 'pane:1',
              paneRuntimeId: 1,
              ptyId: 'pty-stall',
              paneTitle: null
            }
          ]
        })

        await vi.advanceTimersByTimeAsync(11_000)
        const outcome = await settled

        // The create fails, but the timeout must not kill the live terminal (the "tab dies after ~10s" symptom).
        expect(outcome.ok).toBe(false)
        if (outcome.ok === false) {
          expect(outcome.error.message).toContain('Timed out')
        }
        expect(closeTerminal).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
