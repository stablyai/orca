import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import { makeRepo } from '../../persistence-test-harness'
import {
  closeMoveTestStores,
  MOVED,
  moveRequest,
  newDataFile,
  openStore,
  seedSplitSource,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  WT
} from './terminal-leaf-move-fixture'
import { closeLeafOrTab } from './terminal-topology-commit'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

afterEach(closeMoveTestStores)

const request = { ...moveRequest, ptyId: 'pty-agent' }

/** What `session:close-terminal-surface` commits for a close the renderer already performed. */
async function rendererClose(
  store: ReturnType<typeof openStore>,
  target: TerminalSurfaceCloseTarget,
  reason: 'user' | 'cleanup'
): Promise<void> {
  await store.runDurableMutation(
    closeLeafOrTab({
      worktreeId: WT,
      target,
      options: { allowMissing: true, force: true, closedByLayoutOwner: true, reason },
      requestedSession: store.getWorkspaceSession(),
      ownerMatches: () => true,
      hostIds: () => ['local'],
      getSession: (hostId) => store.getWorkspaceSession(hostId),
      setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
      onClosed: () => {}
    })
  )
}

async function openMovedStore() {
  const dataFile = newDataFile()
  const store = openStore(dataFile)
  store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
  await seedSplitSource(store)
  await expect(store.moveTerminalLeafToNewTab(request)).resolves.toMatchObject({
    status: 'moved'
  })
  return { dataFile, store }
}

function restartedTabs(store: ReturnType<typeof openStore>, dataFile: string) {
  store.flush()
  const session = openStore(dataFile).getWorkspaceSession()
  return { tabIds: (session.tabsByWorktree[WT] ?? []).map((tab) => tab.id), session }
}

// The renderer rolls a committed move forward: when the pane is gone it closes main's new tab.
describe('a close that lands while main commits the move', () => {
  it('leaves no dead pane after restart when the user closed the moved pane', async () => {
    const { dataFile, store } = await openMovedStore()
    // The pane close reaches main after the move, so main no longer has SOURCE:leaf.
    await rendererClose(store, { kind: 'pane', tabId: SOURCE, leafId: MOVED }, 'user')
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])

    await rendererClose(store, { kind: 'tab', tabId: TARGET }, 'cleanup')

    const { tabIds, session } = restartedTabs(store, dataFile)
    expect(tabsHoldingLeaf(session, MOVED)).toEqual([])
    expect(tabIds).toEqual([SOURCE])
  })

  it('leaves no ghost tab after restart when the user closed the source tab', async () => {
    const { dataFile, store } = await openMovedStore()
    await rendererClose(store, { kind: 'tab', tabId: SOURCE }, 'user')

    await rendererClose(store, { kind: 'tab', tabId: TARGET }, 'cleanup')

    const { tabIds, session } = restartedTabs(store, dataFile)
    expect(tabIds).toEqual([])
    expect(tabsHoldingLeaf(session, MOVED)).toEqual([])
  })
})

// Why the renderer refuses to drag a pane whose spawn is in flight: a move with no PTY id lets the
// late spawn result bind SOURCE:leaf, and that bind grafts the leaf back into the source tab.
it('grafts a late spawn result for the moved leaf back into its source tab', async () => {
  const store = openStore(newDataFile())
  await seedSplitSource(store)
  await store.moveTerminalLeafToNewTab({ ...request, ptyId: null })
  await store.persistPtyBinding({
    worktreeId: WT,
    tabId: SOURCE,
    leafId: MOVED,
    ptyId: 'pty-late',
    incarnationId: 'inc-late'
  })
  expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED).sort()).toEqual([SOURCE, TARGET])
})
