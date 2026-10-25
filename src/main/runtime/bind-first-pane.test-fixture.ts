// Layout-owner builds bind a terminal's pane before they register it (L80): the PTY host's spawn
// commit writes the binding, then registers. Fixtures that register terminals themselves, or fake
// the spawn, stand in for that commit here. Window-owned builds write nothing, as before.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getConnectionExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { asProfileSessionStore, storeOf } from './profile-session-store.test-fixture'
import { reusedTerminalIdUnbinding } from '../persistence/loading-store/reused-terminal-id-unbind'
import { layoutContainsLeafId } from '../persistence/restoring-sessions/terminal-layout-normalization'
import type { OrcaRuntimeService } from './orca-runtime'

export { boundSessionOf, forgetInstalledPaneSession } from './profile-session-store.test-fixture'

export type BoundPane = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  /** The new tab's view mode, as the creating client saved it. */
  viewMode?: 'chat' | 'terminal'
  /** The process the spawn commit stamps on the pane. */
  incarnationId?: string
}

/** The pane's incarnation stamped, and a reused id unbound from older panes, as the commit does. */
function stampedSession(
  session: WorkspaceSessionState,
  pane: BoundPane,
  incarnationId: string
): WorkspaceSessionState {
  const next = { ...session, ...reusedTerminalIdUnbinding(session, { ...pane, incarnationId }) }
  return {
    ...next,
    terminalPtyIncarnationsByPaneKey: {
      ...next.terminalPtyIncarnationsByPaneKey,
      [`${pane.tabId}:${pane.leafId}`]: incarnationId
    }
  }
}

/** The session with the pane bound to its terminal: the tab and leaf added when missing. */
export function withBoundPane(
  given: WorkspaceSessionState,
  pane: BoundPane
): WorkspaceSessionState {
  const session = pane.incarnationId ? stampedSession(given, pane, pane.incarnationId) : given
  const tabs = session.tabsByWorktree[pane.worktreeId] ?? []
  const hasTab = tabs.some((tab) => tab.id === pane.tabId)
  const layout = session.terminalLayoutsByTabId[pane.tabId]
  const leaf = { type: 'leaf' as const, leafId: pane.leafId }
  const root = !layout?.root
    ? leaf
    : layoutContainsLeafId(layout.root, pane.leafId)
      ? layout.root
      : { type: 'split' as const, direction: 'vertical' as const, first: layout.root, second: leaf }
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [pane.worktreeId]: hasTab
        ? tabs
        : [
            ...tabs,
            {
              id: pane.tabId,
              ptyId: pane.ptyId,
              worktreeId: pane.worktreeId,
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: tabs.length,
              createdAt: 1,
              ...(pane.viewMode ? { viewMode: pane.viewMode } : {})
            }
          ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [pane.tabId]: {
        ...layout,
        activeLeafId: layout?.activeLeafId ?? pane.leafId,
        expandedLeafId: layout?.expandedLeafId ?? null,
        root,
        ptyIdsByLeafId: { ...layout?.ptyIdsByLeafId, [pane.leafId]: pane.ptyId }
      }
    }
  }
}

/**
 * As the spawn commit: binds the pane in the runtime's store session before registration. A
 * store with no session gets an in-memory one, as a profile always has. No-op with the switch off.
 */
export function bindPaneFirst(
  runtime: OrcaRuntimeService,
  pane: BoundPane,
  hostId = 'local'
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const store = storeOf(runtime)
  if (!store) {
    throw new Error('bindPaneFirst needs a runtime with a store: main binds panes in its layout')
  }
  const session = asProfileSessionStore(store, hostId)
  const current = session.get(hostId)
  session.set(withBoundPane(current, pane), hostId)
}

/** As main's pane move to a new tab: the pane leaves `fromTabId` (a tab left empty goes) first. */
export function movePaneFirst(
  runtime: OrcaRuntimeService,
  fromTabId: string,
  pane: BoundPane,
  hostId = 'local'
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  const store = storeOf(runtime)
  const session = store?.getWorkspaceSession?.(hostId)
  if (!store?.setWorkspaceSession || !session) {
    throw new Error('movePaneFirst needs a pane bindPaneFirst bound')
  }
  const { [fromTabId]: _left, ...layouts } = session.terminalLayoutsByTabId
  store.setWorkspaceSession(
    {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [pane.worktreeId]: (session.tabsByWorktree[pane.worktreeId] ?? []).filter(
          (tab) => tab.id !== fromTabId
        )
      },
      terminalLayoutsByTabId: layouts
    },
    hostId
  )
  bindPaneFirst(runtime, pane, hostId)
}

/** registerPty as the PTY host's commit runs it: the pane is bound first. */
export function registerBoundPty(
  runtime: OrcaRuntimeService,
  ptyId: string,
  worktreeId: string,
  connectionId: string | null,
  binding: { tabId: string; leafId: string } & Record<string, unknown>
): void {
  const { incarnationId } = binding
  bindPaneFirst(runtime, {
    worktreeId,
    tabId: binding.tabId,
    leafId: binding.leafId,
    ptyId,
    ...(typeof incarnationId === 'string' ? { incarnationId } : {})
  })
  runtime.registerPty(ptyId, worktreeId, connectionId, binding)
}

/**
 * A live terminal in a layout-owner build: bound and registered, as the spawn commit or a daemon
 * reattach leaves it. Window-owned suites prove liveness through the window graph, so this is a no-op.
 */
export function registerLivePty(
  runtime: Parameters<typeof registerBoundPty>[0],
  ptyId: string,
  worktreeId: string,
  connectionId: string | null,
  binding: { tabId: string; leafId: string } & Record<string, unknown>
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    registerBoundPty(runtime, ptyId, worktreeId, connectionId, binding)
  }
}

/** A fake PTY host spawn that commits as the real one does: it binds the pane, then answers. */
export function committingSpawn<
  Args extends { worktreeId?: string; tabId?: string; leafId?: string },
  Result extends { id: string }
>(
  runtime: OrcaRuntimeService,
  spawn: (args: Args) => Promise<Result>,
  hostId = 'local'
): (args: Args) => Promise<Result> {
  return async (args) => {
    const result = await spawn(args)
    if (args.worktreeId && args.tabId && args.leafId && typeof result?.id === 'string') {
      bindPaneFirst(
        runtime,
        {
          worktreeId: args.worktreeId,
          tabId: args.tabId,
          leafId: args.leafId,
          ptyId: result.id
        },
        hostId
      )
    }
    return result
  }
}

/**
 * As the PTY host's commit, for a store with sessions: binds the pane the runtime wrote before the
 * spawn, and refuses one closed since. A store that cannot write panes gets the one it would have.
 */
function commitIntoWrittenPane(
  runtime: OrcaRuntimeService,
  args: SpawnArgs,
  result: unknown
): void {
  const ptyId = result && typeof result === 'object' && 'id' in result ? result.id : null
  const store = storeOf(runtime)
  if (
    !store?.getWorkspaceSession ||
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId ||
    typeof ptyId !== 'string'
  ) {
    return
  }
  const { worktreeId, tabId, leafId } = args
  const holdsPane = (hostId: string): boolean => {
    const session = store.getWorkspaceSession?.(hostId)
    return (
      (session?.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) ?? false) &&
      layoutContainsLeafId(session?.terminalLayoutsByTabId?.[tabId]?.root ?? null, leafId)
    )
  }
  // The partition the runtime wrote the pane in; with no admission, the one bindPaneFirst uses.
  const hostId = !Reflect.has(store, 'admitTerminalPane')
    ? 'local'
    : [getConnectionExecutionHostId(args.connectionId), 'local'].find(holdsPane)
  if (hostId) {
    bindPaneFirst(runtime, { worktreeId, tabId, leafId, ptyId }, hostId)
  }
}

type SpawnArgs = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]

type PtyControllerRuntimePrototype = {
  setPtyController: (this: OrcaRuntimeService, controller: RuntimePtyController | null) => void
}

// Controllers a test keeps from the stand-in commit, to drive a path that registers unbound.
const uncommittedControllers = new WeakSet<RuntimePtyController>()

/** Keeps commitFakeSpawnsInRuntimeTests from binding this controller's spawns. */
export function leaveSpawnsUncommitted(controller: RuntimePtyController): RuntimePtyController {
  uncommittedControllers.add(controller)
  return controller
}

/**
 * Gives every fake PTY controller a suite installs the real controller's spawn commit, which binds
 * the pane before the runtime registers it. A spawn already committing binds the same pane again.
 */
export function commitFakeSpawnsInRuntimeTests(prototype: PtyControllerRuntimePrototype): void {
  const setPtyController = prototype.setPtyController
  prototype.setPtyController = function (controller) {
    // No spawn, nothing to commit: the suite's own object, so its methods see themselves as `this`.
    if (typeof controller?.spawn !== 'function' || uncommittedControllers.has(controller)) {
      setPtyController.call(this, controller)
      return
    }
    const commit = (args: SpawnArgs, result: unknown): void =>
      commitIntoWrittenPane(this, args, result)
    // An accessor on the suite's own object, not a copy: a suite that swaps its spawn later
    // (a spy, a reassignment) still has its new spawn committed.
    type Spawn = NonNullable<RuntimePtyController['spawn']>
    const committed = new WeakMap<Spawn, Spawn>()
    let current: Spawn = controller.spawn
    Object.defineProperty(controller, 'spawn', {
      configurable: true,
      enumerable: true,
      get: () => {
        const own = current
        let wrapped = committed.get(own)
        if (!wrapped) {
          wrapped = async (args) => {
            const result = await own.call(controller, args)
            commit(args, result)
            return result
          }
          committed.set(own, wrapped)
        }
        return wrapped
      },
      set: (next: Spawn) => {
        current = next
      }
    })
    setPtyController.call(this, controller)
  }
}

/**
 * A recoverable pane's terminal as production loses it: the host's inventory answers without it
 * and reports no exit, so the record disconnects and main keeps the pane. Window-owned builds keep
 * the exit (code 0) these suites drove before.
 */
export async function dropFromHostInventory(
  runtime: OrcaRuntimeService,
  ptyId: string
): Promise<void> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    runtime.onPtyExit(ptyId, 0)
    return
  }
  const encoded = getPtyExecutionHost(ptyId)
  const hostId = encoded && encoded !== 'foreign' ? encoded : 'local'
  const controller = runtime['ptyController']
  const base: RuntimePtyController = controller ?? {
    write: () => false,
    kill: () => false,
    getForegroundProcess: async () => null
  }
  // Inherits the suite's controller, so its other methods keep their own `this`.
  const inventory: RuntimePtyController = Object.assign(Object.create(base), {
    listProcesses: async () => [],
    listProcessesWithHostScope: async () => ({ processes: [], hostIds: ['local', hostId] }),
    hasPty: () => false
  })
  runtime['ptyController'] = inventory
  try {
    await runtime['refreshPtyWorktreeRecordsWithControllerInventory']([])
  } finally {
    runtime['ptyController'] = controller
  }
}
