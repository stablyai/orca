import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, syncSinglePty, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { electronMocks } from './orca-runtime-test-mocks.spec'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_QUERY_METHODS } from './rpc/methods/terminal/terminal-query-methods'

async function createPaneTitleRuntime() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime title routing only checks that the mocked desktop window is not destroyed.
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
  const runtime = createRuntime()
  syncSinglePty(runtime)
  const setPaneTitle = vi.fn(() => true)
  const renameTerminal = vi.fn()
  const notifier = { ...createMobileCreateTestNotifier(vi.fn()), setPaneTitle, renameTerminal }
  runtime.setNotifier(notifier)
  const handle = (await runtime.listTerminals()).terminals[0].handle
  return { runtime, handle, setPaneTitle, renameTerminal, notifier }
}

describe('pane-scoped terminal title', () => {
  it('uses the durable leaf and trims or clears without changing the tab', async () => {
    const { runtime, handle, setPaneTitle, renameTerminal } = await createPaneTitleRuntime()
    await expect(runtime.setPaneTitle(handle, '  REVIEWER  ')).resolves.toEqual({
      handle,
      tabId: 'tab-1',
      leafId: 'pane:1',
      title: 'REVIEWER'
    })
    expect(setPaneTitle).toHaveBeenCalledExactlyOnceWith('tab-1', 'pane:1', 'REVIEWER')
    await runtime.setPaneTitle(handle, '   ')
    expect(setPaneTitle).toHaveBeenLastCalledWith('tab-1', 'pane:1', null)
    expect(renameTerminal).not.toHaveBeenCalled()
    await runtime.renameTerminal(handle, 'Tab name')
    expect(renameTerminal).toHaveBeenCalledWith('tab-1', 'Tab name')
    expect(setPaneTitle).toHaveBeenCalledTimes(2)
  })

  it('rejects stale handles after a leaf is replaced, even if its numeric id is reused', async () => {
    const { runtime, handle, setPaneTitle } = await createPaneTitleRuntime()
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: 'replacement',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'replacement',
          paneRuntimeId: 1,
          ptyId: 'pty-2',
          paneTitle: null
        }
      ]
    })
    await expect(runtime.setPaneTitle(handle, 'WRONG')).rejects.toThrow('terminal_handle_stale')
    await expect(runtime.setPaneTitle('unknown-handle', 'WRONG')).rejects.toThrow(
      'terminal_handle_stale'
    )
    expect(setPaneTitle).not.toHaveBeenCalled()
  })

  it('refuses a desktop without the new notification handler', async () => {
    const { runtime, handle, notifier } = await createPaneTitleRuntime()
    const { setPaneTitle: _unused, ...legacyNotifier } = notifier
    runtime.setNotifier(legacyNotifier)
    await expect(runtime.setPaneTitle(handle, 'REVIEWER')).rejects.toThrow(
      'require a running Orca desktop'
    )
  })

  it('does not report success when the desktop stops accepting notifications', async () => {
    const { runtime, handle, setPaneTitle, renameTerminal } = await createPaneTitleRuntime()
    setPaneTitle.mockReturnValue(false)
    await expect(runtime.setPaneTitle(handle, 'REVIEWER')).rejects.toThrow('runtime_unavailable')
    expect(setPaneTitle).toHaveBeenCalledExactlyOnceWith('tab-1', 'pane:1', 'REVIEWER')
    expect(renameTerminal).not.toHaveBeenCalled()
  })

  it('returns an RPC failure receipt when title notification delivery fails', async () => {
    const { runtime, handle, setPaneTitle } = await createPaneTitleRuntime()
    setPaneTitle.mockReturnValue(false)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_QUERY_METHODS })
    await expect(
      dispatcher.dispatch({
        id: 'pane-title-request',
        authToken: 'test',
        method: 'terminal.setPaneTitle',
        params: { terminal: handle, title: 'REVIEWER' }
      })
    ).resolves.toMatchObject({
      id: 'pane-title-request',
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
    expect(setPaneTitle).toHaveBeenCalledTimes(1)
  })
})
