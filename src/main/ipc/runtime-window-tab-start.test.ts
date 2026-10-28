// Main-owned layout accepts tab starts from its window's real runtime IPC path, while refusing paired callers.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import {
  setupLayoutOwnerRuntime,
  WORKTREE_ID
} from '../runtime/orca-runtime-layout-owner-start-fixture'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: handleMock, on: vi.fn(), removeAllListeners: vi.fn(), removeHandler: vi.fn() }
}))
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

import { registerRuntimeHandlers } from './runtime'

const TAB_ID = 'window-tab'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'
const START = {
  worktree: `id:${WORKTREE_ID}`,
  windowTab: true,
  tabId: TAB_ID,
  leafId: LEAF_ID,
  command: 'make dev'
}

async function runtimeWithWindowTab() {
  const fixture = setupLayoutOwnerRuntime()
  const reply = await fixture.runtime.applyLayoutCommand({
    type: 'createTerminalTab',
    workspace: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID
  })
  expect(reply.ok).toBe(true)
  return fixture
}

describe("the window's new tab started by main, by caller", () => {
  it("starts it for this host's own window over the desktop runtime IPC", async () => {
    const { runtime, spawn } = await runtimeWithWindowTab()
    handleMock.mockReset()
    registerRuntimeHandlers(runtime)
    const call = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')![1]
    const mainFrame = {}
    const event = {
      sender: { id: 1, mainFrame, on: vi.fn(), once: vi.fn() },
      senderFrame: mainFrame
    }

    const result = await call(event, { method: 'terminal.create', params: START })

    expect(result).toMatchObject({ ok: true, result: { terminal: { tabId: TAB_ID } } })
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF_ID, command: 'make dev' })
    )
  })

  it('refuses a paired caller, which never draws this host’s tabs', async () => {
    const { runtime, spawn } = await runtimeWithWindowTab()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_LIFECYCLE_METHODS })

    const result = await dispatcher.dispatch(
      { id: 'paired', authToken: 'token', method: 'terminal.create', params: START },
      { clientId: 'device-1', pairedDeviceId: 'device-1', clientKind: 'runtime' }
    )

    expect(result).toMatchObject({ ok: false, error: { message: 'host_not_owned' } })
    expect(spawn).not.toHaveBeenCalled()
  })
})
