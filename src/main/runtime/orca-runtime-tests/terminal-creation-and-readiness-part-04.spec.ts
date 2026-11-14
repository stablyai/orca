import 'node:fs/promises'
import 'node:os'
import 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import '../../../shared/constants'
import { ipcMain } from 'electron'
import { RpcDispatcher } from '../rpc/dispatcher'
import { TERMINAL_METHODS } from '../rpc/methods/terminal/terminal'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import '../terminal/launch/spawned-pty-env-fixtures'
import './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  // A timed-out renderer create could finish later and duplicate a retried terminal.
  it.each([
    ['--focus', { command: 'echo hi', focus: true, presentation: 'focused' }],
    ['interactive agent', { command: 'codex', focus: false, rendererBacked: true, activate: false }]
  ])(
    'reports the running CLI terminal, not a failure, when the window is slow (%s)',
    async (_case, params) => {
      vi.useFakeTimers()
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
      const windowSend = vi.fn()
      // Leave reveal unresolved to exercise its 10s timeout.
      const revealTerminalSession = vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('Terminal reveal timed out')), 10_000)
          })
      )
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: windowSend }
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const response = dispatcher.dispatch({
        id: 'request-1',
        authToken: 'token',
        method: 'terminal.create',
        params: { worktree: `id:${TEST_WORKTREE_ID}`, ...params }
      })
      // Launch resolution performs real I/O; wait for reveal before advancing timers.
      await vi.waitFor(() =>
        expect(revealTerminalSession.mock.calls.length + windowSend.mock.calls.length).toBe(1)
      )
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(response).resolves.toMatchObject({
        ok: true,
        result: {
          terminal: {
            handle: expect.stringMatching(/^term_/),
            worktreeId: TEST_WORKTREE_ID,
            surface: 'background',
            warning: expect.stringContaining('Terminal reveal timed out')
          }
        }
      })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(windowSend).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
    }
  )

  it('accepts workspace-less terminal create replies only from the target renderer', async () => {
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: { send: vi.fn() } },
        { requestId: payload.requestId, error: 'spoofed renderer reply' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Renderer Terminal',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Renderer Terminal' }
      )
    })
    webContents.send = send
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    await expect(
      runtime.createTerminal(undefined, {
        command: 'codex',
        title: 'Renderer Terminal'
      })
    ).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: 'tab-renderer',
      title: 'Renderer Terminal',
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        requestId: expect.any(String),
        command: 'codex',
        title: 'Renderer Terminal'
      })
    )
    expect(electronMocks.ipcMain.removeListener).toHaveBeenCalledWith(
      'terminal:tabCreateReply',
      expect.any(Function)
    )
  })
})
