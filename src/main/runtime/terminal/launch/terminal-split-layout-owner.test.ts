import { describe, expect, it, vi } from 'vitest'
import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../../orca-runtime-tests/orca-runtime-test-scenario-builders.spec'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { ProvisioningRuntime } from '../../orca-runtime-tests/orca-runtime-layout-owner-start-fixture'
import {
  committingSpawn,
  registerBoundPty
} from '../../orca-runtime-tests/bind-first-pane.test-fixture'

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
    const spawn = vi.fn(async (args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
      statusesSeen.push(runtime.startStatusOf(`${args.tabId}:${args.leafId}`))
      return { id: `pty-split-${spawn.mock.calls.length}` }
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getCwd: async () => '/repo/src'
    })
    // The source pane's terminal runs, bound in main's layout as its spawn commit left it.
    registerBoundPty(runtime, 'pty-0', TEST_WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: HEADLESS_LEAF_ID
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
      resolvedWorkspace: {
        id: TEST_WORKTREE_ID,
        path: TEST_WORKTREE_PATH,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      },
      command: 'make test',
      cols: 120,
      rows: 40
    })
    // Publish starting status to prevent views spawning duplicates, then clear it after binding.
    expect(statusesSeen).toEqual([{ status: 'starting' }])
    expect(runtime.startStatusOf(makePaneKey(TAB_ID, split.leafId ?? ''))).toBeNull()
    expect(split.tabId).toBe(TAB_ID)
  })

  it('splits with the source tab’s explicit shell instead of the current default', async () => {
    const { runtime, getSession, setSession, spawn } = setup()
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          shellOverride: 'powershell.exe'
        }))
      }
    })
    await runtime.splitTerminalPane(
      { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: HEADLESS_LEAF_ID },
      { direction: 'vertical', newLeafId: NEW_LEAF_ID, keepPaneOnStartFailure: true }
    )
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      shellOverride: 'powershell.exe',
      cwd: '/repo/src'
    })
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
})
