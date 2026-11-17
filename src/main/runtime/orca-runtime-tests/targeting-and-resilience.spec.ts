import { describe, expect, it, vi } from 'vitest'
import { bindPaneFirst, registerBoundPty } from './bind-first-pane.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import './runtime-test-module-registration.spec'
import { MOCK_GIT_WORKTREES, electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { AgentBrowserBridge } from '../../browser/agent-browser/agent-browser-bridge'
import type { IPtyProvider } from '../../providers/pty/provider-contract'
import '../../git/worktrees/removal/worktree-removal-preflight'
import { ipcMain } from 'electron'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'

function createBrowserBridge(overrides: Partial<AgentBrowserBridge>): AgentBrowserBridge {
  return Object.assign(vi.mockObject(AgentBrowserBridge.prototype), overrides)
}

describe('OrcaRuntimeService', () => {
  describe('browser page targeting', () => {
    function mockLiveBrowserGuest(): void {
      electronMocks.webContents.fromId.mockReturnValue({
        isDestroyed: () => false,
        isLoading: () => false
      })
    }

    it('does not silently drop invalid explicit worktree selectors for page-targeted commands', async () => {
      vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
      mockLiveBrowserGuest()
      const runtime = createRuntime()
      const snapshotMock = vi.fn<AgentBrowserBridge['snapshot']>()

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          snapshot: snapshotMock,
          getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
          getRegisteredPageWebContentsId: (page: string) => (page === 'page-1' ? 1 : undefined)
        })
      )

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
      const tabListMock = vi.fn<AgentBrowserBridge['tabList']>()

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          tabList: tabListMock
        })
      )

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

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          getRegisteredTabs: vi.fn(() => new Map([['page-1', 1]])),
          getRegisteredPageWebContentsId: (page: string) => (page === 'page-1' ? 1 : undefined)
        })
      )

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

      runtime.setAgentBrowserBridge(
        createBrowserBridge({
          getRegisteredTabs: getRegisteredTabsMock,
          getRegisteredPageWebContentsId: (page: string, worktreeId?: string) =>
            getRegisteredTabsMock(worktreeId).get(page)
        })
      )

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
    ) {
      return {
        spawn: vi.fn<IPtyProvider['spawn']>(),
        attach: vi.fn<IPtyProvider['attach']>(),
        write: vi.fn<IPtyProvider['write']>(),
        writeWithSettlement: vi.fn<IPtyProvider['writeWithSettlement']>(),
        resize: vi.fn<IPtyProvider['resize']>(),
        shutdown: vi.fn<IPtyProvider['shutdown']>().mockResolvedValue(undefined),
        sendSignal: vi.fn<IPtyProvider['sendSignal']>(),
        getCwd: vi.fn<IPtyProvider['getCwd']>(),
        getInitialCwd: vi.fn<IPtyProvider['getInitialCwd']>(),
        clearBuffer: vi.fn<IPtyProvider['clearBuffer']>(),
        resetInputModes: vi.fn<IPtyProvider['resetInputModes']>(),
        acknowledgeDataEvent: vi.fn<IPtyProvider['acknowledgeDataEvent']>(),
        hasChildProcesses: vi.fn<IPtyProvider['hasChildProcesses']>(),
        getForegroundProcess: vi.fn<IPtyProvider['getForegroundProcess']>(),
        serialize: vi.fn<IPtyProvider['serialize']>(),
        revive: vi.fn<IPtyProvider['revive']>(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn<IPtyProvider['getDefaultShell']>(),
        getProfiles: vi.fn<IPtyProvider['getProfiles']>(),
        onData: vi.fn<IPtyProvider['onData']>().mockReturnValue(() => {}),
        onReplay: vi.fn<IPtyProvider['onReplay']>().mockReturnValue(() => {}),
        onExit: vi.fn<IPtyProvider['onExit']>().mockReturnValue(() => {})
      } satisfies IPtyProvider
    }

    it('does not start Git removal when physical PTY stop cannot be proven', async () => {
      // Retain the live PTY in fresh inventory so failed stop cannot be mistaken for proven exit.
      const localProvider = createProviderStub(async () => [
        { id: 'pty-1', cwd: '/tmp', title: 'shell' }
      ])
      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => localProvider
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait: vi.fn(async () => false),
        getForegroundProcess: async () => null
      })
      await syncSinglePty(runtime, 'pty-1')

      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
        'Failed to physically stop every PTY'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
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
        await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
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

        // Disconnect must settle promptly without closing the real terminal.
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
        await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
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

        // Main-owned layouts require the spawn's binding; a renderer leaf cannot vouch for a live PTY.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          registerBoundPty(runtime, 'pty-stall', TEST_WORKTREE_ID, null, {
            tabId: 'tab-stall',
            leafId: '88888888-8888-4888-8888-888888888888'
          })
          await vi.advanceTimersByTimeAsync(50)
          expect(await settled).toEqual({ ok: true })
          expect(closeTerminal).not.toHaveBeenCalled()
          return
        }
        // A live shell exists, but stalled renderer publication never registered its pane key.
        bindPaneFirst(runtime, {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'tab-stall',
          leafId: 'pane:1',
          ptyId: 'pty-stall'
        })
        await runtime.syncWindowGraph(1, {
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
