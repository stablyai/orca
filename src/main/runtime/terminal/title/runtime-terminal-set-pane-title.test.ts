import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import {
  createRuntime,
  syncSinglePty,
  TEST_WORKTREE_ID
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { electronMocks } from '../../orca-runtime-test-mocks/setup.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-tests/orca-runtime-test-scenario-builders.spec'

async function createPaneTitleRuntime() {
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
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
})
