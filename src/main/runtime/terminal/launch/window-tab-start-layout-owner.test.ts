import { describe, expect, it, vi } from 'vitest'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from '../../orca-runtime-layout-owner-start-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB_ID = 'window-tab'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

async function windowTab(runtime: ReturnType<typeof setupLayoutOwnerRuntime>['runtime']) {
  // The window drew the tab and recorded it in main under its own ids, as createTab does.
  const reply = await runtime.applyLayoutCommand({
    type: 'createTerminalTab',
    workspace: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID
  })
  expect(reply.ok).toBe(true)
}

describe("the window's new tab, started by main in a layout-owner build", () => {
  it('starts the first pane in the tab the window wrote, in its folder, with nothing revealed', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    await windowTab(runtime)
    const statuses: unknown[] = []
    spawn.mockImplementationOnce(async (args) => {
      statuses.push(runtime.startStatusOf(`${args.tabId}:${args.leafId}`))
      return { id: 'pty-window' }
    })

    const created = await runtime.startWindowTabTerminal(
      WORKTREE_ID,
      { tabId: TAB_ID, leafId: LEAF_ID },
      { cwd: '/workspace/sub', command: 'make dev' }
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID,
      cwd: '/workspace/sub',
      command: 'make dev'
    })
    // Views see the pane starting, so none starts its own; the start clears it.
    expect(statuses).toEqual([{ status: 'starting' }])
    expect(runtime.startStatusOf(`${TAB_ID}:${LEAF_ID}`)).toBeNull()
    expect(created).toMatchObject({ tabId: TAB_ID, ptyId: 'pty-window', surface: 'background' })
    // The window's tab, not a second one.
    expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(collectLeafIds(session().terminalLayoutsByTabId[TAB_ID]?.root)).toEqual([LEAF_ID])
  })

  it('keeps the pane showing why when its start fails, as a start that timed out does', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    await windowTab(runtime)
    spawn.mockRejectedValueOnce(new Error('Request timed out: createOrAttach'))

    await expect(
      runtime.startWindowTabTerminal(WORKTREE_ID, { tabId: TAB_ID, leafId: LEAF_ID }, {})
    ).rejects.toThrow('Request timed out: createOrAttach')

    expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(runtime.startStatusOf(`${TAB_ID}:${LEAF_ID}`)).toEqual({
      status: 'failed',
      reason: 'Request timed out: createOrAttach'
    })
  })

  it("refuses a paired server's tab, starting nothing, so the window starts it as today", async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()
    await windowTab(runtime)
    Object.assign(runtime, {
      getWorkspaceSessionHostIdsForTab: () => [toRuntimeExecutionHostId('env-1')]
    })

    await expect(
      runtime.startWindowTabTerminal(WORKTREE_ID, { tabId: TAB_ID, leafId: LEAF_ID }, {})
    ).rejects.toThrow('host_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })
})
