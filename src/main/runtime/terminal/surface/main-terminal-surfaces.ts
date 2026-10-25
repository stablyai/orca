// Layout-owner builds: the runtime graph carries main's own panes for every workspace main owns,
// and main republishes them when the Store's layout changes, whether or not a window publishes.

import type { PaneStartFactOf } from '../../pane-start-statuses'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { MainPaneBinding } from './main-pane-verdict'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { withMainSessionTabRows } from '../../session-tabs/main-session-tab-rows'
import { withMainTabOrder } from '../../session-tabs/main-session-tab-order'
import { headlessMobileSnapshotContentUnchanged } from '../../mobile-session-snapshot-equality'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { WorkspaceLayoutReads } from '../../workspace-layout-stream'
import {
  composeMainTerminalSurfaces,
  pairedRuntimeHostOfBinding,
  terminalHoldsPane,
  TerminalSurfaceIndex,
  type BoundTerminal,
  type MainTerminalSurfaces
} from './terminal-surface-index'

export type MainTerminalSurfacesHost = {
  store: () => Pick<RuntimeStore, 'getWorkspaceSessionHostIds' | 'getSettings'> | null
  /** Main's one layout projection. */
  reads: () => WorkspaceLayoutReads
  homeHostId: (key: string) => ExecutionHostId | null
  /** The PTY registry's terminal of that id, or null. */
  registered: (ptyId: string) => BoundTerminal | null
  /** Whether the host certified the terminal exited (not merely disconnected or unverifiable). */
  exited: (ptyId: string) => boolean
  /** Whether the terminal runs now. */
  live: (ptyId: string) => boolean
  /** Main's start status of a pane, as the layout stream publishes it. */
  paneStartFact: PaneStartFactOf
  /** The graph authority now, when its graph is ready; null otherwise. */
  readyGraphPublisher: () => number | null
  /** Installs a graph under the publisher's authority, as the window's own publication does. */
  publish: (windowId: number, graph: RuntimeSyncWindowGraph) => void
  /** The session.tabs rows the runtime holds, by workspace. */
  heldRows: () => ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  /** Stores a workspace's rows and pushes them to its subscribers. */
  replaceHeldRows: (worktreeId: string, next: RuntimeMobileSessionTabsSnapshot) => void
  /** The rows less every terminal the window path's exit filters retire. */
  fenceExited: (rows: RuntimeMobileSessionTabsSnapshot) => RuntimeMobileSessionTabsSnapshot
}

class MainSurfacePublisher {
  private readonly index: TerminalSurfaceIndex
  /** The window's last graph: its mount facts and the panes of workspaces main does not own. */
  private lastWindowGraph: { windowId: number; graph: RuntimeSyncWindowGraph } | null = null
  /** The main surfaces the last installed graph carried. */
  private installed: MainTerminalSurfaces | null = null
  private scheduled = false
  private forceNext = false
  private mergeNext = false

  constructor(private readonly host: MainTerminalSurfacesHost) {
    this.index = new TerminalSurfaceIndex({
      reads: host.reads,
      hostIds: () => host.store()?.getWorkspaceSessionHostIds?.() ?? [],
      homeHostId: host.homeHostId,
      generatedTitlesEnabled: () => host.store()?.getSettings?.().tabAutoGenerateTitle === true,
      onChanged: () => this.schedule({ merge: true })
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
    const projected = this.index.lastSessionTabsOf(published.worktree)
    return projected ? withMainSessionTabRows(published, projected, this.host.exited) : published
  }

  /** Rows a writer stores, ordered and grouped as main's last projection has them: no read. */
  withMainOrder(written: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsSnapshot {
    const projected = this.index.lastSessionTabsOf(written.worktree)
    return projected ? withMainTabOrder(written, projected) : written
  }

  /**
   * After a layout commit: held rows take main's new rows, names and order. A row main's layout
   * lacks stays (drops are the close path's); an added terminal passes the window's exit filters.
   */
  private mergeIntoHeldRows(): void {
    this.index.surfaces()
    for (const [worktreeId, held] of this.host.heldRows()) {
      const projected = this.index.lastSessionTabsOf(held.worktree)
      if (!projected) {
        continue
      }
      const merged = withMainSessionTabRows(held, projected, this.host.exited, {
        live: this.host.live,
        keepUnlisted: true
      })
      const heldIds = new Set(held.tabs.map((row) => row.id))
      const next = merged.tabs.some((row) => row.type === 'terminal' && !heldIds.has(row.id))
        ? this.host.fenceExited(merged)
        : merged
      if (!headlessMobileSnapshotContentUnchanged(held, next)) {
        this.host.replaceHeldRows(worktreeId, next)
      }
    }
  }

  /** The pane main's layout binds a terminal to, read fresh; null when no pane main owns holds it. */
  findPaneForPty(ptyId: string): { worktreeId: string; tabId: string; leafId: string } | null {
    const surfaces = this.index.surfaces()
    const terminal = this.host.registered(ptyId)
    const pane = surfaces.leaves.find(
      (leaf) =>
        leaf.ptyId === ptyId &&
        (pairedRuntimeHostOfBinding(ptyId) !== null ||
          terminalHoldsPane(
            terminal,
            leaf,
            surfaces.paneFacts.get(`${leaf.tabId}::${leaf.leafId}`)
          ))
    )
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

  /** Whether a graph was installed; before that the index only answers queries. */
  get started(): boolean {
    return this.lastWindowGraph !== null
  }

  /** A terminal registered: main's panes reflect it now, in the same push, not at a later sync. */
  terminalRegistered(ptyId: string): void {
    this.index.invalidateRouting()
    if (!this.started) {
      return
    }
    // Registering can also move a workspace to its SSH partition, which changes main's panes.
    this.republish({ force: this.findPaneForPty(ptyId) !== null })
  }

  /** Whether any pane main's layout holds binds the id, whichever terminal holds it now. */
  bindsTerminal(ptyId: string): boolean {
    return this.index.surfaces().leaves.some((leaf) => leaf.ptyId === ptyId)
  }

  /** A pane's terminal came or went: its record changes with no layout change, so reinstall. */
  terminalChanged(): void {
    this.index.invalidateRouting()
    // A binding main made before its terminal connected reaches the held rows now.
    this.schedule({ force: true, merge: true })
  }

  /** Deferred so a connected flip, noted inside syncWindowGraph's record update, cannot recurse into it. */
  private schedule(opts: { force?: boolean; merge?: boolean } = {}): void {
    this.forceNext ||= opts.force === true
    this.mergeNext ||= opts.merge === true
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      const { forceNext: force, mergeNext: merge } = this
      this.scheduled = false
      this.forceNext = false
      this.mergeNext = false
      this.republish({ force })
      if (merge) {
        this.mergeIntoHeldRows()
      }
    })
  }
}

/** The runtime a publisher belongs to; any runtime instance, held weakly. */
export type SurfacesOwner = WeakKey

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
  const state = byRuntime.get(runtime)
  return state?.started ? state : null
}

/** A terminal registered: routing may move, so the index re-reads it even before any graph. */
export function mainTerminalRegistered(runtime: SurfacesOwner, ptyId: string): void {
  byRuntime.get(runtime)?.terminalRegistered(ptyId)
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
  tabId?: string | null
  paneKey?: string | null
  surfaceRecordedAtGraphSequence?: number
}

/** A terminal record's update with no pane claim: main's layout answers for the pane (L80). */
export function withoutPaneClaim<State extends PaneClaim>(
  state: State
): Omit<State, keyof PaneClaim> {
  const {
    tabId: _tabId,
    paneKey: _paneKey,
    surfaceRecordedAtGraphSequence: _stamp,
    ...rest
  } = state
  return rest
}

/** What main's composed panes read from a terminal record (terminalHoldsPane and liveness). */
export type MainPaneRecordFacts = {
  connected: boolean
  incarnationId: string | null
  worktreeId: string
}

/** The facts of a record before an update; undefined for a record not yet made. */
export function mainPaneRecordFacts(
  record: MainPaneRecordFacts | undefined
): MainPaneRecordFacts | undefined {
  return (
    record && {
      connected: record.connected,
      incarnationId: record.incarnationId,
      worktreeId: record.worktreeId
    }
  )
}

/**
 * A terminal record arrived, or its connection, incarnation or workspace changed: main's panes
 * that bind its id re-compose, though no layout changed. Read after the update, so the record
 * the panes compare against is the one now registered; an unchanged refresh notes nothing.
 */
export function noteMainPaneRecordChange(
  runtime: SurfacesOwner,
  prior: MainPaneRecordFacts | undefined,
  next: MainPaneRecordFacts & { ptyId: string }
): void {
  if (
    prior &&
    prior.connected === next.connected &&
    prior.incarnationId === next.incarnationId &&
    prior.worktreeId === next.worktreeId
  ) {
    return
  }
  const surfaces = startedMainTerminalSurfaces(runtime)
  if (surfaces?.bindsTerminal(next.ptyId)) {
    surfaces.terminalChanged()
  }
}

/** Whether main's layout still holds the pane; null before main has published its panes. */
export function mainLayoutHoldsPane(runtime: SurfacesOwner, paneKey: string): boolean | null {
  const surfaces = startedMainTerminalSurfaces(runtime)
  const pane = parsePaneKey(paneKey)
  return surfaces && pane ? surfaces.paneOf(pane.tabId, pane.leafId) !== null : null
}

/** Whether another pane still holds an agent session: a terminal of it that has not exited, or no
 *  terminal at all, which switch-on holds only while main's layout still holds the pane. */
export function paneHoldsSession(
  runtime: SurfacesOwner,
  paneKey: string,
  panePtyIds: readonly string[],
  exited: (ptyId: string) => boolean
): boolean {
  if (panePtyIds.length > 0) {
    return panePtyIds.some((ptyId) => !exited(ptyId))
  }
  return !ORCA_LAYOUT_OWNER_IS_MAIN || mainLayoutHoldsPane(runtime, paneKey) !== false
}

/**
 * Switch-on, whether a pane in the workspace is main's own: then the pane existing proves nothing
 * about its terminal, whose record and the host's inventory decide whether it runs. A paired
 * server's workspace (a `runtime:<env>` window graph) keeps the window's rule.
 */
export function mainDecidesLeafLiveness(runtime: SurfacesOwner, worktreeId: string): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN && mainListsEveryPane(runtime, worktreeId)
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
