import { closeTestStores, createStore, testState } from './persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLayoutLeafIdsInOrder } from '../shared/workspace-layout/terminal-pane-tree'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'
import { _resetClosedPaneFencesForTests } from './persistence/terminal-topology/closed-pane-binding-fence'
import { closeLeafOrTab } from './persistence/terminal-topology/terminal-topology-commit'
import { captureTerminalCloseRequest } from './runtime/terminal-surface-close'
import type { TerminalSurfaceCloseTarget } from '../shared/terminal-surface-close-target'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE = 'repo1::/worktree'
const TAB = 'host-tab'

type TestStore = ReturnType<typeof createStore>

/** A tab main wrote and whose terminal started, then a split main wrote whose terminal is starting. */
async function tabWithStartingSplit(store: TestStore): Promise<void> {
  expect(
    await store.admitTerminalPane({
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1
    })
  ).toBe('admitted')
  expect(
    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'source-pty',
      mayCreate: false
    })
  ).toBe(true)
  expect(
    await store.admitTerminalPane({
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      direction: 'vertical',
      newLeafId: TEST_LEAF_2
    })
  ).toBe('admitted')
}

/** The window's spawn of the split's terminal committing late: it names no expected state. */
function lateWindowBinding(store: TestStore): Promise<boolean> {
  return store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: TAB,
    leafId: TEST_LEAF_2,
    ptyId: 'late-pty',
    origin: 'spawn'
  })
}

/** Main's own close of a pane or tab (the CLI's, a phone's), through the one close transaction. */
async function closeThroughMain(
  store: TestStore,
  target: TerminalSurfaceCloseTarget
): Promise<void> {
  const hostIds: readonly ExecutionHostId[] = [LOCAL_EXECUTION_HOST_ID]
  const refusal = await store.runDurableMutation(
    closeLeafOrTab({
      worktreeId: WORKTREE,
      target,
      options: { allowMissing: true },
      ...captureTerminalCloseRequest(WORKTREE, target, hostIds, store, false),
      ownerMatches: () => true,
      hostIds: () => hostIds,
      getSession: (hostId) => store.getWorkspaceSession(hostId),
      setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
      onClosed: () => {}
    })
  )
  expect(refusal).toBeUndefined()
}

function leafIds(store: TestStore): string[] {
  const root = store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root
  return root ? collectLayoutLeafIdsInOrder(root) : []
}

describe('a pane main closed or took back is not brought back by its late terminal binding', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-closed-pane-fence-'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    _resetClosedPaneFencesForTests()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses the binding of a split main took back when its terminal did not start in time', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)

    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2
    })

    expect(await lateWindowBinding(store)).toBe(false)
    expect(leafIds(store)).toEqual([TEST_LEAF_1])
  })

  it('refuses the binding of a pane the user closed while its terminal was starting', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)

    const reply = await store.applyLayoutCommand({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2,
      userPaneClose: true
    })
    expect(reply.ok).toBe(true)

    expect(await lateWindowBinding(store)).toBe(false)
    expect(leafIds(store)).toEqual([TEST_LEAF_1])
  })

  it('refuses the binding of a pane main closed while its terminal was starting', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)

    await closeThroughMain(store, { kind: 'pane', tabId: TAB, leafId: TEST_LEAF_2 })

    expect(await lateWindowBinding(store)).toBe(false)
    expect(leafIds(store)).toEqual([TEST_LEAF_1])
  })

  it('refuses the binding of a pane whose tab the window closed while it was starting', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)

    const reply = await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE,
      tabIds: [TAB],
      force: true
    })
    expect(reply.ok).toBe(true)

    expect(await lateWindowBinding(store)).toBe(false)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]).toBeUndefined()
  })

  it('binds a pane the window creates again under the same id', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2
    })

    const reply = await store.applyLayoutCommand({
      type: 'splitPane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      direction: 'vertical',
      newLeafId: TEST_LEAF_2
    })
    expect(reply.ok).toBe(true)
    expect(await lateWindowBinding(store)).toBe(true)
  })

  it('binds a pane a real create wrote again under the same id', async () => {
    const store = createStore()
    await tabWithStartingSplit(store)
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2
    })

    expect(
      await store.admitTerminalPane({
        type: 'splitPane',
        workspace: WORKTREE,
        tabId: TAB,
        leafId: TEST_LEAF_1,
        direction: 'vertical',
        newLeafId: TEST_LEAF_2
      })
    ).toBe('admitted')
    expect(await lateWindowBinding(store)).toBe(true)
    expect(leafIds(store)).toEqual([TEST_LEAF_1, TEST_LEAF_2])
  })

  it('lets a binding create the pane again once the binding window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = createStore()
    await tabWithStartingSplit(store)
    await store.withdrawTerminalPane({
      type: 'closePane',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_2
    })

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000)
    expect(await lateWindowBinding(store)).toBe(true)
    expect(leafIds(store)).toEqual([TEST_LEAF_1, TEST_LEAF_2])
  })
})
