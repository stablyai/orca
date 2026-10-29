import {
  loadWorkspaceLayoutUnits,
  loadWorkspaceLayoutWithoutReport
} from '../../shared/workspace-layout/workspace-layout-load'
// Reproject dirty Store partitions and publish each workspace only from its owning partition.

import type { ExecutionHostId } from '../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

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
import type { SessionChangeSet } from '../../shared/session-change-set'
import type { RuntimeStore } from './runtime-store-contract'

export type ProjectedLayout = { layout: PublishedWorkspaceLayout; json: string }

export type ProjectionStore = Pick<
  RuntimeStore,
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'getPtyBindingGeneration'
  | 'getLayoutEditorViews'
  | 'readWorkspaceSessionUnits'
  | 'getWorkspaceSessionReferences'
>

export type DirtyPartitions = Set<ExecutionHostId> | 'all'

/** Carry binding generations on leaves and in-memory editor views on workspaces. */
export function runtimeLayoutLoadContext(
  store: Pick<RuntimeStore, 'getPtyBindingGeneration' | 'getLayoutEditorViews'> | null,
  hostId: ExecutionHostId
): WorkspaceLayoutLoadContext {
  // Window-owned builds retain name-based loading without views or generations.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !store) {
    return nameBasedLoadContext()
  }
  const generationOf = store.getPtyBindingGeneration
  const views = store.getLayoutEditorViews?.(hostId)
  return {
    ...nameBasedLoadContext(),
    ...(generationOf
      ? { ptyGenerationOf: (leafId: string) => generationOf.call(store, hostId, leafId) }
      : {}),
    // No saved views still means known-empty views.
    ...(store.getLayoutEditorViews ? { editorViewsOf: (key: string) => views?.[key] } : {})
  }
}

class ProjectedPartition {
  private published: Map<string, ProjectedLayout> | null = null

  loadedStale = false

  constructor(
    private readonly hostId: ExecutionHostId,
    readonly loaded: LoadedWorkspaceLayout | null
  ) {}

  update(owners: ReadonlySet<string>, loaded: LoadedWorkspaceLayout): void {
    const published = this.workspaces()
    for (const key of owners) {
      const workspace = loaded.layout.workspaces[key]
      if (workspace) {
        const layout = publishWorkspaceLayout(workspace, this.hostId)
        published.set(key, { layout, json: stableJson(layout) })
      } else {
        published.delete(key)
      }
    }
    this.loadedStale = true
  }

  /** Includes stray copies of workspaces owned by other partitions. */
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
  published = new Map<string, ProjectedLayout>()
  private partitions = new Map<ExecutionHostId, ProjectedPartition>()
  private readonly pendingOwners = new Map<ExecutionHostId, Set<string>>()
  private changed: ReadonlySet<string> | null = null
  private stale: DirtyPartitions = 'all'
  /** Keep routing failures separate so they cannot suppress later projection/listener errors. */
  private routingFailureLogged = false

  constructor(
    private readonly deps: {
      store: () => ProjectionStore | null
      homeHostId: (key: string) => ExecutionHostId | null
    }
  ) {}

  clear(): void {
    this.published.clear()
    this.forgetPartitions()
  }

  forgetPartitions(): void {
    this.partitions.clear()
    this.pendingOwners.clear()
    this.stale = 'all'
  }

  invalidate(hostId: ExecutionHostId | null, changes?: SessionChangeSet): void {
    if (changes && !changes.fullReplacement && this.stale !== 'all') {
      const owners = this.pendingOwners.get(changes.hostId) ?? new Set<string>()
      for (const key of changes.owners) {
        owners.add(key)
      }
      this.pendingOwners.set(changes.hostId, owners)
      const partition = this.partitions.get(changes.hostId)
      if (partition) {
        partition.loadedStale = true
      }
      return
    }
    if (hostId === null || this.stale === 'all') {
      this.stale = 'all'
    } else {
      this.stale.add(hostId)
    }
  }

  /** Cache only for readers that invalidate on every write; null without a Store. */
  loaded(hostId: ExecutionHostId, keep: boolean): LoadedWorkspaceLayout | null {
    if (!keep) {
      return this.loadPartition(hostId).loaded
    }
    const partition = this.cachedPartition(hostId)
    if (!partition.loadedStale) {
      return partition.loaded
    }
    // A caller explicitly requesting a partition pays for its complete read.
    return this.loadPartition(hostId).loaded
  }

  changedKeys(): ReadonlySet<string> | null {
    return this.changed
  }

  project(): Map<string, ProjectedLayout> {
    const store = this.deps.store()
    if (this.stale === 'all' || this.stale.size || !store?.readWorkspaceSessionUnits) {
      const hostIds = store?.getWorkspaceSessionHostIds?.() ?? []
      const partitions = new Map(hostIds.map((hostId) => [hostId, this.cachedPartition(hostId)]))
      this.partitions = partitions
      this.published = this.route(partitions)
      this.changed = null
      this.pendingOwners.clear()
      return this.published
    }
    const changed = new Set<string>()
    for (const [hostId, owners] of this.pendingOwners) {
      const projection = store.readWorkspaceSessionUnits([...owners], hostId)
      const loaded = loadWorkspaceLayoutUnits(
        hostId,
        projection.reader,
        projection.owners,
        projection.selected,
        runtimeLayoutLoadContext(store, hostId)
      )
      const partition = this.partitions.get(hostId) ?? new ProjectedPartition(hostId, null)
      partition.update(owners, loaded)
      this.partitions.set(hostId, partition)
      for (const key of owners) {
        changed.add(key)
      }
    }
    this.pendingOwners.clear()
    const unroutable = new Set<string>()
    for (const key of changed) {
      const home = this.homeOf(key, unroutable)
      if (unroutable.has(key)) {
        continue
      }
      const next = home && this.partitions.get(home)?.workspaces().get(key)
      if (next) {
        this.published.set(key, next)
      } else {
        this.published.delete(key)
      }
    }
    this.changed = changed
    return this.published
  }

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
        // Publish only the owning partition's copy.
        if (this.homeOf(key, unroutable) === hostId) {
          projected.set(key, workspace)
        }
      }
    }
    for (const key of unroutable) {
      const kept = this.published.get(key)
      // Retain the last publication: a removed frame would drop the window's tabs.
      if (kept && !projected.has(key)) {
        projected.set(key, kept)
      }
    }
    return projected
  }

  /** Record unroutable keys without stopping peers; guessing a repeated repo/path could publish another host's copy. */
  private homeOf(key: string, unroutable: Set<string>): ExecutionHostId | null {
    try {
      return this.deps.homeHostId(key)
    } catch (error) {
      // Window-owned builds retain whole-projection failure.
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
