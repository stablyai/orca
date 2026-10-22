import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-test-scenario-builders.spec'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { ProvisioningRuntime } from '../../orca-runtime-layout-owner-start-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'host-tab'
const NEW_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function graph() {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'shell',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        leafId: HEADLESS_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'pty-0',
        paneTitle: null
      }
    ]
  }
}

describe('a split of a pane the window draws, in a layout-owner build', () => {
  function setup() {
    const store = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const notifier = { ...createMobileCreateTestNotifier(vi.fn()), closeTerminalPane: vi.fn() }
    const runtime = new ProvisioningRuntime(store.runtimeStore)
    runtime.setNotifier(notifier)
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: TEST_WORKTREE_ID,
        path: TEST_WORKTREE_PATH,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      }))
    })
    const statusesSeen: unknown[] = []
    const spawn = vi.fn(async (args: { tabId?: string; leafId?: string }) => {
      statusesSeen.push(runtime.startStatusOf(`${args.tabId}:${args.leafId}`))
      return { id: `pty-split-${spawn.mock.calls.length}` }
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getCwd: async () => '/repo/src'
    })
    runtime.syncWindowGraph(1, graph())
    const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))
    const leafIds = () =>
      collectLayoutLeafIdsInOrder(store.getSession().terminalLayoutsByTabId[TAB_ID]!.root!)
    return {
      ...store,
      notifier,
      runtime,
      spawn,
      statusesSeen,
      handle: handle!,
      splitTerminal: vi.mocked(notifier.splitTerminal),
      leafIds
    }
  }

  it('main writes the pane and starts its terminal there, in the source pane’s folder; the window is not asked', async () => {
    const { runtime, handle, splitTerminal, leafIds, spawn, statusesSeen } = setup()

    const split = await runtime.splitTerminal(handle, {
      direction: 'vertical',
      command: 'make test'
    })

    expect(splitTerminal).not.toHaveBeenCalled()
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, split.leafId])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      tabId: TAB_ID,
      leafId: split.leafId,
      cwd: '/repo/src',
      command: 'make test',
      cols: 120,
      rows: 40
    })
    // Views see the pane as starting while it starts, so none starts its own; then it clears.
    expect(statusesSeen).toEqual([{ status: 'starting' }])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, split.leafId ?? ''))).toBeNull()
    expect(split.tabId).toBe(TAB_ID)
  })

  it('lists the new pane to phones and session.tabs with no window report', async () => {
    const { runtime, handle } = setup()
    // A phone already lists the tab, so the new pane must be published, not just hydrated.
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    const split = await runtime.splitTerminal(handle, { direction: 'vertical' })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.tabs.some(
        (tab) =>
          tab.type === 'terminal' && tab.parentTabId === TAB_ID && tab.leafId === split.leafId
      )
    ).toBe(true)
  })

  it('a split no one asked to see leaves the phones’ active tab alone; one asked for takes it', async () => {
    const { runtime, handle } = setup()
    const listed = () => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const before = (await listed()).activeTabId

    await runtime.splitTerminal(handle, { direction: 'vertical', activate: false })
    expect((await listed()).activeTabId).toBe(before)

    const shown = await runtime.splitTerminal(handle, { direction: 'horizontal' })
    expect((await listed()).activeTabId).toBe(`${TAB_ID}::${shown.leafId}`)
  })

  it('the window’s own split keeps its proposed pane id, folder and size', async () => {
    const { runtime, leafIds, spawn } = setup()

    const split = await runtime.splitTerminalPane(
      { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
      {
        direction: 'horizontal',
        newLeafId: NEW_LEAF_ID,
        cwd: TEST_WORKTREE_PATH,
        initialSize: { cols: 90, rows: 20 },
        keepPaneOnStartFailure: true
      }
    )

    expect(split.leafId).toBe(NEW_LEAF_ID)
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, NEW_LEAF_ID])
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      leafId: NEW_LEAF_ID,
      cwd: TEST_WORKTREE_PATH,
      cols: 90,
      rows: 20
    })
  })

  it('a window split whose terminal fails to start keeps its pane, showing why', async () => {
    const { runtime, leafIds, spawn } = setup()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical', newLeafId: NEW_LEAF_ID, keepPaneOnStartFailure: true }
      )
    ).rejects.toThrow('shell not found')

    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, NEW_LEAF_ID])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, NEW_LEAF_ID))).toEqual({
      status: 'failed',
      reason: 'shell not found'
    })
  })

  it('a CLI split whose terminal fails to start leaves no pane, and the CLI hears why', async () => {
    const { runtime, handle, leafIds, spawn, notifier } = setup()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).rejects.toThrow(
      'shell not found'
    )

    expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
    expect(notifier.closeTerminalPane).not.toHaveBeenCalled()
  })

  it('starts nothing when main cannot write the pane', async () => {
    const { runtime, runtimeStore, handle, splitTerminal, leafIds, spawn } = setup()
    Reflect.set(
      runtimeStore,
      'admitTerminalPane',
      vi.fn(async () => 'pane_not_found')
    )

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).rejects.toThrow(
      'terminal_split_source_not_found'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(leafIds()).toEqual([HEADLESS_LEAF_ID])
  })

  it('starts nothing for a pane-named split of a tab main does not hold', async () => {
    const { runtime, spawn } = setup()

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: 'tab-elsewhere', leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical' }
      )
    ).rejects.toThrow('terminal_split_source_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  // The real spawn commit refuses a pane that left the layout while it started (spawn-commit.ts).
  function closeWhileStarting(setupResult: ReturnType<typeof setup>, close: () => Promise<void>) {
    const { spawn, getSession } = setupResult
    spawn.mockImplementationOnce(async (args: { tabId?: string; leafId?: string }) => {
      await close()
      const root = getSession().terminalLayoutsByTabId[TAB_ID]?.root
      if (!root || !collectLayoutLeafIdsInOrder(root).includes(args.leafId!)) {
        throw new Error('terminal_split_source_not_found')
      }
      return { id: 'pty-late' }
    })
  }

  it.each([
    ['its pane', { kind: 'pane', tabId: TAB_ID, leafId: NEW_LEAF_ID }],
    ['its tab', { kind: 'tab', tabId: TAB_ID }]
  ] as const)(
    'answers a split once, and leaves nothing, when the user closes %s while it starts',
    async (_, target) => {
      const context = setup()
      const { runtime, getSession } = context
      closeWhileStarting(context, () =>
        runtime.closeTerminalSurfaceFromRenderer({
          worktreeId: TEST_WORKTREE_ID,
          target,
          reason: 'user'
        })
      )

      await expect(
        runtime.splitTerminalPane(
          { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
          { direction: 'vertical', newLeafId: NEW_LEAF_ID, keepPaneOnStartFailure: true }
        )
      ).rejects.toThrow('terminal_split_source_not_found')

      const root = getSession().terminalLayoutsByTabId[TAB_ID]?.root
      expect(root ? collectLayoutLeafIdsInOrder(root) : []).not.toContain(NEW_LEAF_ID)
      // Nothing is left showing a start for a pane that is gone.
      expect(runtime.startStatusOf(makePaneKey(TAB_ID, NEW_LEAF_ID))).toBeNull()
    }
  )

  it('refuses a named pane id another pane already holds, starting nothing', async () => {
    const { runtime, spawn } = setup()

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical', newLeafId: HEADLESS_LEAF_ID }
      )
    ).rejects.toThrow('pane_exists')
    expect(spawn).not.toHaveBeenCalled()
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))).toBeNull()
  })

  it('a window split main cannot start at all still shows its pane, failed, with why', async () => {
    const { runtime, leafIds } = setup()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical', newLeafId: NEW_LEAF_ID, keepPaneOnStartFailure: true }
      )
    ).rejects.toThrow('runtime_unavailable')

    expect(leafIds()).toEqual([HEADLESS_LEAF_ID, NEW_LEAF_ID])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, NEW_LEAF_ID))).toEqual({
      status: 'failed',
      reason: 'runtime_unavailable'
    })
  })

  it('refuses a taken pane id before anything else, even when main cannot start', async () => {
    const { runtime } = setup()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.splitTerminalPane(
        { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
        { direction: 'vertical', newLeafId: HEADLESS_LEAF_ID, keepPaneOnStartFailure: true }
      )
    ).rejects.toThrow('pane_exists')
    // The live pane is not marked as a failed start.
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, HEADLESS_LEAF_ID))).toBeNull()
  })
})
