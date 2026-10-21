// Each workspace's published layout, projected from the Store's session partitions: a partition
// is re-run through the Loader only when a write may have changed it, and each workspace is
// published from the partition that owns it.

import type { ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import type {
  LoadedWorkspaceLayout,
  WorkspaceLayoutLoadContext
} from '../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import type { RuntimeStore } from './runtime-store-contract'

export type ProjectedLayout = { layout: PublishedWorkspaceLayout; json: string }

export type ProjectionStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'getPtyBindingGeneration'
>

/** Partitions to re-project; 'all' when a write did not name its partition. */
export type DirtyPartitions = Set<ExecutionHostId> | 'all'

/** The context main loads a partition with: its panes' binding generations ride the leaves. */
export function runtimeLayoutLoadContext(
  store: Pick<RuntimeStore, 'getPtyBindingGeneration'> | null,
  hostId: ExecutionHostId
): WorkspaceLayoutLoadContext {
  const generationOf = store?.getPtyBindingGeneration
  // Switch point: a window-owned build publishes no generation.
  return ORCA_LAYOUT_OWNER_IS_MAIN && generationOf
    ? {
        ...nameBasedLoadContext(),
        ptyGenerationOf: (leafId) => generationOf.call(store, hostId, leafId)
      }
    : nameBasedLoadContext()
}

/** One partition as loaded once: its model, and each workspace published from it on first ask. */
class ProjectedPartition {
  private published: Map<string, ProjectedLayout> | null = null

  constructor(
    private readonly hostId: ExecutionHostId,
    readonly loaded: LoadedWorkspaceLayout | null
  ) {}

  /** Every workspace it holds, its own copy of a workspace it does not own included. */
  workspaces(): Map<string, ProjectedLayout> {
    if (!this.published) {
      this.published = new Map()
      for (const [key, workspace] of Object.entries(this.loaded?.layout.workspaces ?? {})) {
        const published = publishWorkspaceLayout(workspace, this.hostId)
        this.published.set(key, { layout: published, json: stableJson(published) })
      }
    }
    return this.published
  }
}

export class WorkspaceLayoutProjection {
  /** Workspace key → its published layout, with its JSON for the by-value comparison. */
  published = new Map<string, ProjectedLayout>()
  private partitions = new Map<ExecutionHostId, ProjectedPartition>()
  /** Partitions a write may have changed since they were loaded. */
  private stale: DirtyPartitions = 'all'
  /** Its own flag, so a routing warning never hides a later projection or listener failure. */
  private routingFailureLogged = false

  constructor(
    private readonly deps: {
      store: () => ProjectionStore | null
      /** The partition that owns a workspace key; null when none does. */
      homeHostId: (key: string) => ExecutionHostId | null
    }
  ) {}

  /** Forgets every projection: the next read re-loads every partition. */
  clear(): void {
    this.published.clear()
    this.forgetPartitions()
  }

  /** After a failed projection too: the next read re-loads every partition. */
  forgetPartitions(): void {
    this.partitions.clear()
    this.stale = 'all'
  }

  /** A write may have changed `hostId`'s partition; null: any partition. */
  invalidate(hostId: ExecutionHostId | null): void {
    if (hostId === null || this.stale === 'all') {
      this.stale = 'all'
    } else {
      this.stale.add(hostId)
    }
  }

  /**
   * One partition's loaded model, re-loaded only if a write may have changed it; null with no
   * Store. Only a reader that hears every write (`invalidate`) may `keep` it for the next read.
   */
  loaded(hostId: ExecutionHostId, keep: boolean): LoadedWorkspaceLayout | null {
    return keep ? this.cachedPartition(hostId).loaded : this.loadPartition(hostId).loaded
  }

  /** Every workspace as published, each stale partition re-loaded; becomes `published`. */
  project(): Map<string, ProjectedLayout> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    const partitions = new Map(hostIds.map((hostId) => [hostId, this.cachedPartition(hostId)]))
    this.partitions = partitions
    this.published = this.route(partitions)
    return this.published
  }

  /** What a projection of every partition from scratch publishes now; changes no cache. */
  projectFresh(): Map<string, ProjectedLayout> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    return this.route(new Map(hostIds.map((hostId) => [hostId, this.loadPartition(hostId)])))
  }

  private cachedPartition(hostId: ExecutionHostId): ProjectedPartition {
    if (this.stale === 'all') {
      this.stale = new Set(this.deps.store()?.getWorkspaceSessionHostIds?.() ?? [])
      this.partitions.clear()
    }
    const cached = this.stale.has(hostId) ? undefined : this.partitions.get(hostId)
    if (cached) {
      return cached
    }
    const loaded = this.loadPartition(hostId)
    this.partitions.set(hostId, loaded)
    this.stale.delete(hostId)
    return loaded
  }

  private loadPartition(hostId: ExecutionHostId): ProjectedPartition {
    const store = this.deps.store()
    const session = store?.getWorkspaceSession?.(hostId)
    return new ProjectedPartition(
      hostId,
      session
        ? loadWorkspaceLayoutWithoutReport(hostId, session, runtimeLayoutLoadContext(store, hostId))
        : null
    )
  }

  private route(
    partitions: Map<ExecutionHostId, ProjectedPartition>
  ): Map<string, ProjectedLayout> {
    const projected = new Map<string, ProjectedLayout>()
    const unroutable = new Set<string>()
    for (const [hostId, partition] of partitions) {
      for (const [key, workspace] of partition.workspaces()) {
        // Only the owning partition's copy is published; a stray copy elsewhere is not shown.
        if (this.homeOf(key, unroutable) === hostId) {
          projected.set(key, workspace)
        }
      }
    }
    for (const key of unroutable) {
      const kept = this.published.get(key)
      // Kept as last published: a 'removed' frame would make the window drop its tabs.
      if (kept && !projected.has(key)) {
        projected.set(key, kept)
      }
    }
    return projected
  }

  /**
   * A workspace the router throws on is not guessed (`repoId::path` repeats across hosts, so a
   * default could publish another host's copy); it is noted in `unroutable`. It never stops the rest.
   */
  private homeOf(key: string, unroutable: Set<string>): ExecutionHostId | null {
    try {
      return this.deps.homeHostId(key)
    } catch (error) {
      // Switch point: a window-owned build keeps failing the whole projection, as today.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
        throw error
      }
      unroutable.add(key)
      if (!this.routingFailureLogged) {
        this.routingFailureLogged = true
        console.warn('[workspace-layout] layout stream routing failed:', error)
      }
      return null
    }
  }
}
