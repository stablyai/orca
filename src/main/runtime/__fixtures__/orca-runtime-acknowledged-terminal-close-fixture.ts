import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { ipcMain } from 'electron'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
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

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]
type IpcListener = Parameters<typeof ipcMain.on>[1]

const closeIpc = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  listeners: new Map<string, Set<IpcListener>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: InvokeHandler) => closeIpc.handlers.set(name, callback),
    on: (name: string, callback: IpcListener) => {
      const listeners = closeIpc.listeners.get(name) ?? new Set()
      listeners.add(callback)
      closeIpc.listeners.set(name, listeners)
    },
    removeListener: (name: string, callback: IpcListener) =>
      closeIpc.listeners.get(name)?.delete(callback)
  }
}))

export async function createAcknowledgedCloseHarness(lifetimeLoss: 'after-owner' | 'before-owner') {
  const { Store } = await import('../../persistence/loading-store/store')
  const { createSqliteTestStore, closeTestStores } =
    await import('../../persistence/persistence-test-harness')
  const { registerSessionHandlers } = await import('../../ipc/session')
  const { requestTerminalTabCloseFromRenderer } =
    await import('../../window/terminal-tab-close-request-relay')
  const { getRuntimeDesktopSurface, setRuntimeDesktopSurface } =
    await import('../runtime-desktop-surface')
  const { useAppStore } = await import('../../../renderer/src/store')
  const { createTabsSliceMockApi } =
    await import('../../../renderer/src/store/slices/tabs-slice-test-harness')
  const { registerMobileAndTerminalCloseIpcBridge } =
    await import('../../../renderer/src/hooks/ipc-events/mobile-terminal-close-ipc-bridge')
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
  const unsubs: (() => void)[] = []
  type Request = Parameters<Parameters<typeof window.api.ui.onTerminalTabCloseRequest>[0]>[0]
  let requestConsumer: ((request: Request) => void) | undefined
  const webContents = {
    id: 1,
    isDestroyed: () => false,
    setBackgroundThrottling: () => {},
    send: (channel: string, request: Request) => {
      if (channel !== 'ui:terminalTabCloseRequest' || !requestConsumer) {
        throw new Error('close request consumer missing')
      }
      queueMicrotask(() => requestConsumer?.(request))
    }
  }
  const win = { isDestroyed: () => false, webContents }
  registerSessionHandlers(store, runtime)
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = closeIpc.handlers.get(channel)
    if (!handler) {
      throw new Error('session handler missing')
    }
    return handler({ sender: webContents } as never, ...args)
  }
  Object.assign(window.api, {
    session: {
      set: (value: WorkspaceSessionState, hostId?: string | null) =>
        invoke('session:set', value, hostId),
      flush: () => invoke('session:flush'),
      closeTerminalSurface: (args: unknown) => invoke('session:close-terminal-surface', args)
    }
  })
  Object.assign(window.api.ui, {
    onOpenFileFromMobile: () => () => {},
    onOpenDiffFromMobile: () => () => {},
    onCloseTerminal: () => () => {},
    onWorkspaceSleep: () => () => {},
    onResumeSleepingAgents: () => () => {},
    onTerminalTabCloseRequest: (listener: typeof requestConsumer) => {
      requestConsumer = listener
      return () => {
        requestConsumer = undefined
      }
    },
    respondTerminalTabClose: (response: { requestId: string; error?: string }) => {
      queueMicrotask(() => {
        const listeners = closeIpc.listeners.get('ui:terminalTabCloseResponse') ?? []
        for (const listener of listeners) {
          listener({ sender: {} } as never, { ...response, error: 'wrong-sender' })
          listener({ sender: webContents } as never, {
            ...response,
            requestId: 'other-request',
            error: 'wrong-request'
          })
        }
        if (lifetimeLoss === 'before-owner') {
          outage = true
        }
        ackDelivered = true
        order.push('renderer-ack')
        for (const listener of listeners) {
          listener({ sender: webContents } as never, response)
        }
      })
    }
  })
  registerMobileAndTerminalCloseIpcBridge(unsubs, () => {})
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => win as never,
    onIpc: () => {},
    removeIpcListener: () => {}
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
    closeTerminalTab: (tabId, options) =>
      requestTerminalTabCloseFromRenderer(win as never, tabId, options)
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
      for (const unsubscribe of unsubs) {
        unsubscribe()
      }
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
