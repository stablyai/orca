import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

// #30329: a client's pane rename lands in the host's saved layout; host readers must report it.
async function headlessRuntimeWithLivePane() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'pane-title-pty' })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: 'host-tab',
    leafId: HEADLESS_LEAF_ID,
    activate: true
  })
  const renamePane = (titlesByLeafId: Record<string, string>) =>
    runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: getSession().terminalLayoutsByTabId['host-tab']!.root,
      expandedLeafId: null,
      titlesByLeafId
    })
  const listed = async () =>
    (await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals.find(
      (terminal) => terminal.handle === created.handle
    )
  return { runtime, handle: created.handle, renamePane, listed }
}

describe('pane titles in terminal summaries', () => {
  it('reports a client pane rename in terminal.list and terminal.show', async () => {
    const { runtime, handle, renamePane, listed } = await headlessRuntimeWithLivePane()
    expect((await listed())?.paneTitle).toBeUndefined()

    await renamePane({ [HEADLESS_LEAF_ID]: 'server' })

    expect(await listed()).toMatchObject({ handle, paneTitle: 'server' })
    expect((await runtime.showTerminal(handle)).paneTitle).toBe('server')
  })

  it('drops the pane title once a client clears the last one', async () => {
    const { renamePane, listed } = await headlessRuntimeWithLivePane()
    await renamePane({ [HEADLESS_LEAF_ID]: 'server' })

    await renamePane({})

    expect((await listed())?.paneTitle).toBeUndefined()
  })

  it('leaves the terminal title alone, so a pane name never renames the tab', async () => {
    const { renamePane, listed } = await headlessRuntimeWithLivePane()
    const before = (await listed())?.title

    await renamePane({ [HEADLESS_LEAF_ID]: 'server' })

    expect((await listed())?.title).toBe(before)
  })
})
