import { describe, expect, it, vi } from 'vitest'
import { bindPaneFirst, registerBoundPty } from '../../terminal/layout/bind-first-pane.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../browser/agent-browser/agent-browser-bridge'

import '../../../git/worktrees/removal/worktree-removal-preflight'
import { ipcMain } from 'electron'
import '../../../git/worktrees/catalog/worktree-scan-cache'
import '../../../git/worktrees/removal/worktree-removal'
import {
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
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
