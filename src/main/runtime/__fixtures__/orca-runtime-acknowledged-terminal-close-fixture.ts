import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  closeIpc,
  installAcknowledgedCloseRelay
} from './orca-runtime-terminal-close-relay-fixture'
export { installAcknowledgedCloseRelay } from './orca-runtime-terminal-close-relay-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  REPO_ID,
  WORKTREE_PATH,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID,
  INCARNATION_ID,
  RUNTIME_OWNED_PTY_ID,
  makeSession
} from './orca-runtime-terminal-close-continuity-state-fixture'
import { createCloseContinuityGraphFixture } from './orca-runtime-terminal-close-continuity-graph-fixture'

export async function createAcknowledgedCloseHarness(lifetimeLoss: 'after-owner' | 'before-owner') {
  const { Store } = await import('../../persistence/loading-store/store')
  const { createSqliteTestStore, closeTestStores } =
    await import('../../persistence/persistence-test-harness')
  const { getRuntimeDesktopSurface, setRuntimeDesktopSurface } =
    await import('../runtime-desktop-surface')
  const { useAppStore } = await import('../../../renderer/src/store')
  const { createTabsSliceMockApi } =
    await import('../../../renderer/src/store/slices/tabs-slice-test-harness')
  const directory = mkdtempSync(join(tmpdir(), 'orca-terminal-close-'))
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  store.setWorkspaceSession(makeSession(RUNTIME_OWNED_PTY_ID))
  await store.flushPendingOrThrowAsync()
  const readSession = store.getWorkspaceSession.bind(store)
  const originalGetter = Object.getOwnPropertyDescriptor(store, 'getWorkspaceSession')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalRenderer = useAppStore.getState()
  const originalDesktop = getRuntimeDesktopSurface()
  let outage = false
  let ackDelivered = false
  let ownerCompleted = false
  const order: string[] = []
  Object.defineProperty(store, 'getWorkspaceSession', {
    configurable: true,
    value: (hostId?: string | null) => (outage ? undefined : readSession(hostId))
  })
  const runtime = new OrcaRuntimeService(store)
  const durable = store.runDurableMutation.bind(store)
  vi.spyOn(store, 'runDurableMutation').mockImplementation(async (mutate) => {
    let completed = false
    const value = await durable(() => {
      const result = mutate()
      const session = readSession()
      completed =
        ackDelivered &&
        result.value === undefined &&
        !session.tabsByWorktree[WORKTREE_ID]?.some((row) => row.id === TAB_ID) &&
        Boolean(session.closedTerminalTabTombstonesByTabId?.[TAB_ID])
      return result
    })
    if (completed) {
      ownerCompleted = true
      order.push('runtime-owner-completed')
      if (lifetimeLoss === 'after-owner') {
        outage = true
      }
    }
    return value
  })
  createTabsSliceMockApi()
  const session = readSession()
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      repos: [repo],
      tabsByWorktree: session.tabsByWorktree,
      terminalLayoutsByTabId: session.terminalLayoutsByTabId,
      terminalPtyIncarnationsByPaneKey: session.terminalPtyIncarnationsByPaneKey,
      activeWorktreeId: WORKTREE_ID,
      activeTabId: TAB_ID,
      activeTabType: 'terminal'
    },
    true
  )
  const relay = await installAcknowledgedCloseRelay(store, runtime, () => {
    if (lifetimeLoss === 'before-owner') {
      outage = true
    }
    ackDelivered = true
    order.push('renderer-ack')
  })
  runtime.attachWindow(1)
  let alive = true
  const exits: Promise<unknown>[] = []
  const stopState: { saved: boolean; raw: boolean; renderer: boolean; completed: boolean }[] = []
  const stop = vi.fn((ptyId: string) => {
    stopState.push({
      saved: Boolean(readSession().tabsByWorktree[WORKTREE_ID]?.some((row) => row.id === TAB_ID)),
      raw: Boolean(
        runtime['mobileSessionTabsByWorktree']
          .get(WORKTREE_ID)
          ?.tabs.some((row) => row.type === 'terminal' && row.parentTabId === TAB_ID)
      ),
      renderer: Boolean(
        useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.some((row) => row.id === TAB_ID)
      ),
      completed: ownerCompleted
    })
    order.push('captured-stop')
    if (!alive || ptyId !== RUNTIME_OWNED_PTY_ID) {
      return false
    }
    alive = false
    exits.push(Promise.resolve(runtime.onPtyExit(ptyId, 0, INCARNATION_ID)))
    return true
  })
  const kill = vi.fn((ptyId: string) => stop(ptyId))
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait: async (ptyId) => stop(ptyId),
    listProcesses: async () =>
      alive
        ? [
            {
              id: RUNTIME_OWNED_PTY_ID,
              incarnationId: INCARNATION_ID,
              cwd: WORKTREE_PATH,
              title: 'Fixture shell'
            }
          ]
        : [],
    getForegroundProcess: async () => null
  })
  runtime.registerPty(RUNTIME_OWNED_PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID
  })
  const graph = createCloseContinuityGraphFixture({
    runtime,
    ptyId: RUNTIME_OWNED_PTY_ID,
    publishMobileSurface: true,
    getSession: readSession,
    setSession: (next) => store.setWorkspaceSession(next),
    markSiblingPtyIncluded: () => {}
  })
  graph.syncFixtureGraph()
  graph.syncFixtureTabWithoutLeaf()
  runtime.setNotifier({
    closeTerminal: () => {},
    closeTerminalTab: (tabId, options) => relay.closeTerminalTab(tabId, options)
  } as never)
  const [terminal] = (await runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
  return {
    runtime,
    terminal,
    stop,
    kill,
    stopState,
    order,
    ownerCompleted: () => ownerCompleted,
    sessionUnavailable: () => outage,
    dispose: async () => {
      outage = false
      await Promise.all(exits)
      runtime.setNotifier(null)
      relay.dispose()
      if (originalGetter) {
        Object.defineProperty(store, 'getWorkspaceSession', originalGetter)
      } else {
        delete (store as { getWorkspaceSession?: unknown }).getWorkspaceSession
      }
      useAppStore.setState(originalRenderer, true)
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow)
      } else {
        delete (globalThis as { window?: unknown }).window
      }
      setRuntimeDesktopSurface(originalDesktop)
      closeIpc.handlers.clear()
      closeIpc.listeners.clear()
      await closeTestStores()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
