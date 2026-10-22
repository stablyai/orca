// Layout-owner builds: the terminal tabs and panes of every workspace main owns, read from main's
// one layout projection (the layout stream's) rather than from the window's graph. A paired server's
// workspaces (`runtime:<env>` partitions) are not here: the window still mirrors those.

import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph
} from '../../../../shared/runtime-types'
import type { LoadedWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { bindingOf } from '../../pane-live-facts'
import {
  projectSessionTabs,
  type ProjectedSessionTabs
} from '../../../../shared/workspace-layout/old-client/old-client-session-tabs-projection'
import { projectRuntimeSurfaces } from '../../runtime-leaf-record-projection'
import type { WorkspaceLayoutReads } from '../../workspace-layout-stream'

type LoadedPartition = Pick<LoadedWorkspaceLayout, 'layout' | 'desktopView' | 'facts'>

/** Main's terminal surfaces, in the window graph's shape so the graph's readers take them as is. */
export type MainTerminalSurfaces = {
  tabs: RuntimeSyncedTab[]
  /** A pane with no mounted view has no renderer pane id: -1, as other main-made leaves. */
  leaves: RuntimeSyncedLeaf[]
  /** Every workspace main answers for, a workspace with no terminal tab included. */
  worktreeIds: ReadonlySet<string>
  /** By `tabId::leafId`: the pane's binding as published (bindingOf) and its sleeping record. */
  paneFacts: ReadonlyMap<string, { binding: string; sleeping: boolean }>
}

export class TerminalSurfaceIndex {
  private stopWatching: (() => void) | null = null
  private current: MainTerminalSurfaces | null = null
  private currentJson = ''
  /** The loaded partitions `current` was projected from: the projection's own cached objects. */
  private projectedFrom: (LoadedWorkspaceLayout | null)[] = []
  private projectedHostIds: readonly ExecutionHostId[] = []
  private projectedHomes = ''
  private projectedTitles: boolean | null = null
  /** Workspace key → its home partition, as of the last projection. */
  private routes = new Map<string, ExecutionHostId | null>()
  private routesStale = true

  constructor(
    private readonly deps: {
      /** Main's one layout projection, which the layout stream publishes from. */
      reads: () => WorkspaceLayoutReads | null
      /** Every session partition the Store holds. */
      hostIds: () => readonly ExecutionHostId[]
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
      generatedTitlesEnabled: () => boolean
      /** A layout operation ended, so main's surfaces may have changed. */
      onChanged: () => void
    }
  ) {}

  /** Follows each layout operation's end, which also keeps the projection's partitions cached. */
  start(): void {
    if (this.stopWatching) {
      return
    }
    this.stopWatching =
      this.deps.reads()?.onLayoutOperationCommitted(() => this.deps.onChanged()) ?? null
    this.deps.onChanged()
  }

  stop(): void {
    this.stopWatching?.()
    this.stopWatching = null
  }

  /** Routing may have changed with no write (a terminal registering moves a workspace). */
  invalidateRouting(): void {
    this.routesStale = true
  }

  /** Main's surfaces now: re-projected only when a partition the projection holds was rewritten. */
  surfaces(): MainTerminalSurfaces {
    const reads = this.deps.reads()
    const hostIds = this.deps
      .hostIds()
      .filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
    const loaded = hostIds.map((hostId) => reads?.readPartition(hostId) ?? null)
    const samePartitions =
      loaded.length === this.projectedFrom.length &&
      loaded.every((partition, index) => partition === this.projectedFrom[index])
    // The titles setting changes tab titles with no write, so it keys the cache too.
    const titles = this.deps.generatedTitlesEnabled()
    if (this.current && samePartitions && !this.routesStale && titles === this.projectedTitles) {
      return this.current
    }
    // Routing is read per workspace only here, as the layout stream reads it per write.
    this.routes = new Map(
      loaded.flatMap((partition) =>
        Object.keys(partition?.layout.workspaces ?? {}).map(
          (key) => [key, this.homeOf(key)] as const
        )
      )
    )
    this.routesStale = false
    const homes = JSON.stringify([...this.routes])
    if (
      this.current &&
      samePartitions &&
      homes === this.projectedHomes &&
      titles === this.projectedTitles
    ) {
      return this.current
    }
    this.projectedTitles = titles
    this.projectedFrom = loaded
    this.projectedHostIds = hostIds
    this.projectedHomes = homes
    const next = this.project(hostIds, loaded)
    const json = JSON.stringify({
      tabs: next.tabs,
      leaves: next.leaves,
      paneFacts: [...next.paneFacts]
    })
    // The same object when nothing changed, so a write that moves no pane installs nothing.
    if (!this.current || json !== this.currentJson) {
      this.current = next
      this.currentJson = json
    }
    return this.current
  }

  private project(
    hostIds: readonly ExecutionHostId[],
    loaded: readonly (LoadedWorkspaceLayout | null)[]
  ): MainTerminalSurfaces {
    const partitions: LoadedPartition[] = []
    const worktreeIds = new Set<string>()
    const paneFacts = new Map<string, { binding: string; sleeping: boolean }>()
    hostIds.forEach((hostId, index) => {
      const partition = loaded[index]
      if (!partition) {
        return
      }
      // Only the owning partition's copy counts; a stray copy elsewhere is not a second pane.
      const workspaces = Object.fromEntries(
        Object.entries(partition.layout.workspaces).filter(
          ([key]) => this.routes.get(key) === hostId
        )
      )
      for (const workspace of Object.values(workspaces)) {
        worktreeIds.add(workspace.worktreeId)
        for (const tab of workspace.tabs) {
          if (tab.kind !== 'terminal') {
            continue
          }
          for (const leafId of collectLayoutLeafIdsInOrder(tab.panes.root)) {
            const leaf = workspace.leaves?.[leafId] ?? {}
            paneFacts.set(`${tab.entityId}::${leafId}`, {
              binding: bindingOf(leaf),
              sleeping: leaf.sleeping !== undefined
            })
          }
        }
      }
      partitions.push({ ...partition, layout: { ...partition.layout, workspaces } })
    })
    const { tabs, panes } = projectRuntimeSurfaces(partitions, this.deps.generatedTitlesEnabled())
    return {
      tabs: [...tabs.values()],
      leaves: panes.map(({ tab, worktreeId, leafId, ptyId, liveTitle }) => ({
        tabId: tab.entityId,
        worktreeId,
        leafId,
        paneRuntimeId: -1,
        ptyId,
        paneTitle: null,
        title: tabs.get(tab.entityId)?.title ?? liveTitle
      })),
      worktreeIds,
      paneFacts
    }
  }

  /** A workspace main owns as today's `session.tabs` rows, from its owning partition's layout. */
  sessionTabsOf(worktreeId: string): ProjectedSessionTabs | null {
    this.surfaces()
    return this.lastSessionTabsOf(worktreeId)
  }

  /** As sessionTabsOf, from the partitions last projected: reads no session. */
  lastSessionTabsOf(worktreeId: string): ProjectedSessionTabs | null {
    if (!this.current?.worktreeIds.has(worktreeId)) {
      return null
    }
    for (const [index, partition] of this.projectedFrom.entries()) {
      const hostId = this.projectedHostIds[index]
      for (const [key, workspace] of Object.entries(partition?.layout.workspaces ?? {})) {
        if (partition && workspace.worktreeId === worktreeId && this.routes.get(key) === hostId) {
          return projectSessionTabs(
            key,
            workspace,
            partition.desktopView,
            partition.facts,
            this.deps.generatedTitlesEnabled()
          )
        }
      }
    }
    return null
  }

  private homeOf(key: string): ExecutionHostId | null {
    try {
      return this.deps.homeHostId(key)
    } catch {
      // A workspace the router cannot place is not guessed: no partition answers for it.
      return null
    }
  }
}

/**
 * The window's graph with main's panes in place of the window's own list for every workspace main
 * owns. A pane the window shows takes its renderer pane id and title; any other is parked, as a
 * live pane the window does not mount is today. A pane lists its terminal once that terminal has
 * registered, as the window lists one once its transport attaches.
 */
export function composeMainTerminalSurfaces(
  graph: RuntimeSyncWindowGraph,
  main: MainTerminalSurfaces,
  /** Whether the PTY registry holds the terminal: a saved binding alone is not a live one. */
  registered: (ptyId: string) => boolean
): RuntimeSyncWindowGraph {
  const mounted = new Map(
    (graph.mountedLeaves ?? []).map((leaf) => [`${leaf.tabId}::${leaf.leafId}`, leaf])
  )
  const notMain = (surface: { worktreeId: string }): boolean =>
    !main.worktreeIds.has(surface.worktreeId)
  return {
    ...graph,
    tabs: [...graph.tabs.filter(notMain), ...main.tabs],
    leaves: [
      ...graph.leaves.filter(notMain),
      ...main.leaves.map((bound) => {
        const leaf = bound.ptyId && !registered(bound.ptyId) ? { ...bound, ptyId: null } : bound
        const shown = mounted.get(`${leaf.tabId}::${leaf.leafId}`)
        if (!shown) {
          return { ...leaf, parked: true }
        }
        return {
          ...leaf,
          paneRuntimeId: shown.paneRuntimeId,
          paneTitle: shown.paneTitle ?? null,
          ...(shown.parked ? { parked: true } : {})
        }
      })
    ]
  }
}
