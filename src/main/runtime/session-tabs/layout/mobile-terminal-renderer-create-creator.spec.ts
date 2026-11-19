// A phone's new terminal on a desktop with its window open is spawned by the window, outside the
// phone's RPC; `orca pair` in it must still tag its link with the phone.
import { describe, expect, it, vi } from 'vitest'
import { bindPaneFirst, registerBoundPty } from '../../terminal/layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'
import { ipcMain } from 'electron'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { runWithActiveRpcCaller } from '../../rpc/callers/active-call'
import { pairedCreatorOfTerminal } from '../../rpc/server/pairing/paired-terminal-creators'

function windowRuntime(): OrcaRuntimeService {
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
    closeTerminal: vi.fn(),
    closeSessionTab: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  const webContents = {
    send: vi.fn((_channel: string, payload: { requestId: string }) => {
      bindPaneFirst(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'tab-renderer',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-renderer'
      })
      registerBoundPty(runtime, 'pty-renderer', TEST_WORKTREE_ID, null, {
        tabId: 'tab-renderer',
        leafId: HEADLESS_LEAF_ID
      })
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: HEADLESS_LEAF_ID,
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Terminal' }
      )
    })
  }
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false, webContents })
  return runtime
}

describe('a paired client’s terminal the window spawns', () => {
  it('is that client’s', async () => {
    const runtime = windowRuntime()

    const result = await runWithActiveRpcCaller(
      { kind: 'paired-device', deviceId: 'phone-1' },
      () => runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {})
    )

    expect(result.tab.terminal).toMatch(/^term_/)
    expect(pairedCreatorOfTerminal(result.tab.terminal!)).toBe('phone-1')
  })
})
