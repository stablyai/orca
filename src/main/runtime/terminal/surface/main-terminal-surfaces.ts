// Layout-owner builds: the runtime graph carries main's own panes for every workspace main owns,
// and main republishes them when the Store's layout changes, whether or not a window publishes.
// Only switch-on code reaches this module, so a window-owned build bundles none of it.

import type { PaneStartFactOf } from '../../pane-start-statuses'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { MainPaneBinding } from './main-pane-verdict'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { withMainSessionTabRows } from '../../session-tabs/main-session-tab-rows'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { WorkspaceLayoutReads } from '../../workspace-layout-stream'
import {
  composeMainTerminalSurfaces,
  TerminalSurfaceIndex,
  type MainTerminalSurfaces
} from './terminal-surface-index'

export type MainTerminalSurfacesHost = {
  store: () => Pick<RuntimeStore, 'getWorkspaceSessionHostIds' | 'getSettings'> | null
  /** Main's one layout projection. */
  reads: () => WorkspaceLayoutReads
  homeHostId: (key: string) => ExecutionHostId | null
  /** Whether the PTY registry holds the terminal. */
  registered: (ptyId: string) => boolean
  /** Whether the host certified the terminal exited (not merely disconnected or unverifiable). */
  exited: (ptyId: string) => boolean
  /** Main's start status of a pane, as the layout stream publishes it. */
  paneStartFact: PaneStartFactOf
  /** The graph authority now, when its graph is ready; null otherwise. */
  readyGraphPublisher: () => number | null
  /** Installs a graph under the publisher's authority, as the window's own publication does. */
  publish: (windowId: number, graph: RuntimeSyncWindowGraph) => void
}

class MainSurfacePublisher {
  private readonly index: TerminalSurfaceIndex
  /** The window's last graph: its mount facts and the panes of workspaces main does not own. */
  private lastWindowGraph: { windowId: number; graph: RuntimeSyncWindowGraph } | null = null
  /** The main surfaces the last installed graph carried. */
  private installed: MainTerminalSurfaces | null = null
  private scheduled = false
  private forceNext = false

  constructor(private readonly host: MainTerminalSurfacesHost) {
    this.index = new TerminalSurfaceIndex({
      reads: host.reads,
      hostIds: () => host.store()?.getWorkspaceSessionHostIds?.() ?? [],
      homeHostId: host.homeHostId,
      generatedTitlesEnabled: () => host.store()?.getSettings?.().tabAutoGenerateTitle === true,
      onChanged: () => this.schedule()
    })
  }

  /** The graph a publisher installs: main's panes in place of the window's for what main owns. */
  withMainSurfaces(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeSyncWindowGraph {
    this.index.start()
    this.lastWindowGraph = { windowId, graph }
    this.installed = this.index.surfaces()
    const composed = composeMainTerminalSurfaces(graph, this.installed, this.host.registered)
    return graph.mobileSessionTabs
      ? {
          ...composed,
          mobileSessionTabs: graph.mobileSessionTabs.map((rows) => this.withMainRows(rows))
        }
      : composed
  }

  /** A workspace main owns publishes main's terminal and editor rows; any other, the window's. */
  private withMainRows(
    published: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const projected = this.installed?.worktreeIds.has(published.worktree)
      ? this.index.sessionTabsOf(published.worktree)
      : null
    return projected ? withMainSessionTabRows(published, projected, this.host.exited) : published
  }

  /** The pane main's layout binds a terminal to, read fresh; null when no pane main owns holds it. */
  findPaneForPty(ptyId: string): { worktreeId: string; tabId: string; leafId: string } | null {
    const pane = this.index.surfaces().leaves.find((leaf) => leaf.ptyId === ptyId)
    return pane ? { worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId } : null
  }

  /**
   * A pane main owns: the terminal its layout binds and whether it has a status (a start in flight
   * or failed, or a sleeping agent), which says that binding is not live; null otherwise.
   */
  paneOf(tabId: string, leafId: string): MainPaneBinding | null {
    const surfaces = this.index.surfaces()
    const pane = surfaces.leaves.find((leaf) => leaf.tabId === tabId && leaf.leafId === leafId)
    const facts = surfaces.paneFacts.get(`${tabId}::${leafId}`)
    if (!pane || !facts) {
      return null
    }
    const started = this.host.paneStartFact(`${tabId}:${leafId}`, facts.binding)
    const status = started?.status ?? (facts.sleeping ? 'sleeping' : null)
    return {
      ptyId: pane.ptyId,
      hasStatus: status !== null,
      starting: status === 'starting' || status === 'resuming'
    }
  }

  /** Main's panes with the terminals its layout binds, registered or not. */
  boundLeaves(): readonly { worktreeId: string; ptyId: string | null }[] {
    return this.index.surfaces().leaves
  }

  /** Every workspace main lists the terminals of, read once for a batch of checks. */
  ownedWorkspaces(): ReadonlySet<string> {
    return this.index.surfaces().worktreeIds
  }

  /** Whether main lists the workspace's terminals. */
  ownsWorkspace(worktreeId: string): boolean {
    return this.index.surfaces().worktreeIds.has(worktreeId)
  }

  /** Every pane of a tab main owns, in pane order. */
  panesOfTab(tabId: string): { leafId: string; ptyId: string | null }[] {
    return this.index
      .surfaces()
      .leaves.filter((leaf) => leaf.tabId === tabId)
      .map(({ leafId, ptyId }) => ({ leafId, ptyId }))
  }

  /** Installs main's panes under the current authority, with that publisher's last mount facts. */
  republish(opts: { force?: boolean } = {}): void {
    const windowId = this.host.readyGraphPublisher()
    if (windowId === null || (!opts.force && this.index.surfaces() === this.installed)) {
      return
    }
    const last = this.lastWindowGraph?.windowId === windowId ? this.lastWindowGraph.graph : null
    // Only the terminal list: the window's session rows and grid sizes were taken when it sent them.
    this.host.publish(windowId, {
      tabs: last?.tabs ?? [],
      leaves: last?.leaves ?? [],
      ...(last?.mountedLeaves ? { mountedLeaves: last.mountedLeaves } : {})
    })
  }

  /** Whether the window shows or parks the tab: what a reader of "the renderer lists it" asks. */
  windowListsTab(tabId: string): boolean {
    const windowId = this.host.readyGraphPublisher()
    const last = this.lastWindowGraph?.windowId === windowId ? this.lastWindowGraph.graph : null
    return (
      !!last &&
      (last.tabs.some((tab) => tab.tabId === tabId) ||
        (last.mountedLeaves ?? []).some((leaf) => leaf.tabId === tabId))
    )
  }

  /** A terminal registered: main's panes reflect it now, in the same push, not at a later sync. */
  terminalRegistered(ptyId: string): void {
    this.index.invalidateRouting()
    // Registering can also move a workspace to its SSH partition, which changes main's panes.
    this.republish({ force: this.findPaneForPty(ptyId) !== null })
  }

  /** A pane's terminal came or went: its record changes with no layout change, so reinstall. */
  terminalChanged(): void {
    this.index.invalidateRouting()
    this.schedule({ force: true })
  }

  /** Deferred so a connected flip, noted inside syncWindowGraph's record update, cannot recurse into it. */
  private schedule(opts: { force?: boolean } = {}): void {
    this.forceNext ||= opts.force === true
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      const force = this.forceNext
      this.scheduled = false
      this.forceNext = false
      this.republish({ force })
    })
  }
}

/** The runtime a publisher belongs to; any runtime instance, held weakly. */
type SurfacesOwner = WeakKey

const byRuntime = new WeakMap<SurfacesOwner, MainSurfacePublisher>()

/** The runtime's publisher of main's panes, made on its first graph. */
export function mainTerminalSurfaces(
  runtime: SurfacesOwner,
  host: () => MainTerminalSurfacesHost
): MainSurfacePublisher {
  let state = byRuntime.get(runtime)
  if (!state) {
    state = new MainSurfacePublisher(host())
    byRuntime.set(runtime, state)
  }
  return state
}

/** The runtime's publisher when it has installed a graph; null before that. */
export function startedMainTerminalSurfaces(runtime: SurfacesOwner): MainSurfacePublisher | null {
  return byRuntime.get(runtime) ?? null
}

/**
 * Layout-owner builds: whether the window lists a tab. The runtime graph holds main's own tabs
 * too, so its membership no longer says the window has the tab.
 */
export function windowListsTab(
  runtime: SurfacesOwner,
  tabs: ReadonlyMap<string, unknown>,
  tabId: string
): boolean {
  return startedMainTerminalSurfaces(runtime)?.windowListsTab(tabId) ?? tabs.has(tabId)
}

type PaneClaim = {
  connected?: boolean
  tabId?: string | null
  paneKey?: string | null
  surfaceRecordedAtGraphSequence?: number
}

/**
 * A terminal record's update with main's pane in place of the caller's claim. Looked up only when
 * the claim or the connection changes, since output records every chunk with neither changed.
 */
export function withMainPaneClaim<State extends PaneClaim>(
  runtime: SurfacesOwner,
  prior: { connected: boolean; tabId: string | null; paneKey: string | null } | undefined,
  ptyId: string,
  state: State,
  graphSequence: number
): State {
  const connectedChanges = state.connected !== undefined && prior?.connected !== state.connected
  const claimChanges =
    (state.tabId !== undefined && state.tabId !== prior?.tabId) ||
    (state.paneKey !== undefined && state.paneKey !== prior?.paneKey)
  if (!connectedChanges && !claimChanges) {
    return state
  }
  const surfaces = startedMainTerminalSurfaces(runtime)
  const pane = surfaces?.findPaneForPty(ptyId)
  if (!pane) {
    return state
  }
  // A bound pane's terminal connecting or ending changes its leaf, though no layout changed.
  if (connectedChanges) {
    surfaces?.terminalChanged()
  }
  // A legacy pane id names no pane key; the caller's claim stands for it.
  return claimChanges && isTerminalLeafId(pane.leafId)
    ? {
        ...state,
        tabId: pane.tabId,
        paneKey: makePaneKey(pane.tabId, pane.leafId),
        surfaceRecordedAtGraphSequence: graphSequence
      }
    : state
}

/** Whether main lists the workspace's panes, so terminal.list shows every saved one. */
export function mainListsEveryPane(runtime: SurfacesOwner, worktreeId: string): boolean {
  return startedMainTerminalSurfaces(runtime)?.ownsWorkspace(worktreeId) === true
}

/**
 * The runtime's panes plus every terminal main's layout binds, registered or not: a saved SSH
 * terminal not re-registered since a restart may still run, so a worktree stop still names it.
 */
export function withMainBoundLeaves(
  runtime: SurfacesOwner,
  leaves: Iterable<{ worktreeId: string; ptyId: string | null }>
): { worktreeId: string; ptyId: string | null }[] {
  return [...leaves, ...(startedMainTerminalSurfaces(runtime)?.boundLeaves() ?? [])]
}
