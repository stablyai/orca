import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, makePaneKey } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-test-scenario-builders.spec'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'host-tab'

function graph(leafIds: string[], unboundLeafIds: string[] = []) {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'shell',
        activeLeafId: leafIds[0]!,
        layout: null
      }
    ],
    leaves: [...leafIds, ...unboundLeafIds].map((leafId, index) => ({
      tabId: TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId: index < leafIds.length ? `pty-${index}` : null,
      paneTitle: null
    }))
  }
}

describe('a split of a pane the window draws, in a layout-owner build', () => {
  function setup() {
    const store = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const notifier = createMobileCreateTestNotifier(vi.fn())
    const runtime = new OrcaRuntimeService(store.runtimeStore)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, graph([HEADLESS_LEAF_ID]))
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))
    const leafIds = () =>
      collectLayoutLeafIdsInOrder(store.getSession().terminalLayoutsByTabId[TAB_ID]!.root!)
    return {
      ...store,
      runtime,
      handle: handle!,
      splitTerminal: vi.mocked(notifier.splitTerminal),
      leafIds
    }
  }

  it('writes the new pane in main before the window mounts it, and keeps it however the start goes', async () => {
    const { runtime, runtimeStore, handle, splitTerminal, leafIds } = setup()
    const withdraw = vi.fn(async () => null)
    Reflect.set(runtimeStore, 'withdrawTerminalPane', withdraw)

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle, { direction: 'vertical', command: 'make test' })
      const rejected = expect(split).rejects.toThrow('Timed out waiting for split pane handle')
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const notice = splitTerminal.mock.calls[0]![2]!
      expect(notice).toMatchObject({ command: 'make test', sourceLeafId: HEADLESS_LEAF_ID })
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID, notice.newLeafId])

      // Its terminal never starts: main keeps a dead pane, as any, and takes nothing back.
      await vi.advanceTimersByTimeAsync(11_000)
      await rejected
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID, notice.newLeafId])
      expect(withdraw).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a CLI split before its terminal starts, and nothing brings the pane back', async () => {
    const { runtime, handle, splitTerminal, leafIds } = setup()

    vi.useFakeTimers()
    try {
      const split = runtime.splitTerminal(handle, { direction: 'vertical' })
      const rejected = expect(split).rejects.toThrow('Timed out waiting for split pane handle')
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(1))
      const newLeafId = splitTerminal.mock.calls[0]![2]!.newLeafId!

      await runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: TEST_WORKTREE_ID,
        target: { kind: 'pane', tabId: TAB_ID, leafId: newLeafId },
        reason: 'user'
      })
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID])

      await vi.advanceTimersByTimeAsync(11_000)
      await rejected
      expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
    } finally {
      vi.useRealTimers()
    }
  })

  it('splits nothing when main cannot write the pane', async () => {
    const { runtime, runtimeStore, handle, splitTerminal, leafIds } = setup()
    Reflect.set(
      runtimeStore,
      'admitTerminalPane',
      vi.fn(async () => 'pane_not_found')
    )

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).rejects.toThrow(
      'split_not_written: pane_not_found'
    )
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
  })
})
