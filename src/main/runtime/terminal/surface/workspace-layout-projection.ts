// Reproject dirty Store partitions (only the workspaces a write reported, when it did) and publish each workspace only from its owning partition.

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { stableJson } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-report'
import type {
  LoadedWorkspaceLayoutRead,
  WorkspaceLayoutLoadContext
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import type { WorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-model'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  loadWholePartition,
  reloadWorkspaces,
  type PartitionLoad
} from './workspace-layout-partition-reload'

export type ProjectedLayout = { layout: PublishedWorkspaceLayout; json: string }

export type ProjectionStore = Pick<
  RuntimeStore,
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'getPtyBindingGeneration'
  | 'getLayoutEditorViews'
>

export type DirtyPartitions = Set<ExecutionHostId> | 'all'

/** Per partition, the workspaces written since its last load, or 'whole' when a write did not say. */
type StaleWorkspaces = Map<ExecutionHostId, Set<string> | 'whole'> | 'all'

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
  constructor(
    private readonly hostId: ExecutionHostId,
    readonly load: PartitionLoad | null,
    private published: Map<string, ProjectedLayout> | null = null
  ) {}

  get loaded(): LoadedWorkspaceLayoutRead | null {
    return this.load?.loaded ?? null
  }

  /** Includes stray copies of workspaces owned by other partitions. */
  workspaces(): Map<string, ProjectedLayout> {
    if (!this.published) {
      this.published = new Map()
      for (const [key, workspace] of Object.entries(this.loaded?.layout.workspaces ?? {})) {
        this.published.set(key, publish(workspace, this.hostId))
      }
    }
    return this.published
  }

  /** Republish only the reloaded workspaces; the rest keep their projected objects. */
  reloaded(load: PartitionLoad, keys: readonly string[]): ProjectedPartition {
    if (!this.published || keys.length === 0) {
      return new ProjectedPartition(this.hostId, load, this.published)
    }
    const published = new Map(this.published)
    for (const key of keys) {
      published.set(key, publish(load.loaded.layout.workspaces[key]!, this.hostId))
    }
    return new ProjectedPartition(this.hostId, load, published)
  }
}

function publish(workspace: WorkspaceLayout, hostId: ExecutionHostId): ProjectedLayout {
  const layout = publishWorkspaceLayout(workspace, hostId)
  return { layout, json: stableJson(layout) }
}

export class WorkspaceLayoutProjection {
  published = new Map<string, ProjectedLayout>()
  private partitions = new Map<ExecutionHostId, ProjectedPartition>()
  private stale: StaleWorkspaces = 'all'
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
    this.stale = 'all'
  }

  /** `workspaces` absent: any workspace of the partition may have changed. `refs`: share refs naming more written workspaces. */
  invalidate(
    hostId: ExecutionHostId | null,
    workspaces?: ReadonlySet<string>,
    refs?: ReadonlySet<string>
  ): void {
    if (hostId === null || this.stale === 'all') {
      this.stale = 'all'
      return
    }
    const pending = this.stale.get(hostId)
    const written = workspaces && this.withHolders(hostId, workspaces, refs)
    // Window-owned builds always reload whole partitions.
    if (!written || !ORCA_LAYOUT_OWNER_IS_MAIN || pending === 'whole') {
      this.stale.set(hostId, 'whole')
    } else {
      this.stale.set(hostId, new Set([...(pending ?? []), ...written]))
    }
  }

  /** Add the workspaces holding each ref as of the last load, which any later change to them reported; null when that load kept no refs. */
  private withHolders(
    hostId: ExecutionHostId,
    workspaces: ReadonlySet<string>,
    refs: ReadonlySet<string> | undefined
  ): ReadonlySet<string> | null {
    if (!refs?.size) {
      return workspaces
    }
    const byKey = this.partitions.get(hostId)?.load?.refs?.byKey
    if (!byKey) {
      return null
    }
    const written = new Set(workspaces)
    for (const ref of refs) {
      byKey.keysFor(ref).forEach((key) => written.add(key))
    }
    return written
  }

  /** Cache only for readers that invalidate on every write; null without a Store. */
  loaded(hostId: ExecutionHostId, keep: boolean): LoadedWorkspaceLayoutRead | null {
    return keep ? this.cachedPartition(hostId).loaded : this.loadPartition(hostId, false).loaded
  }

  project(): Map<string, ProjectedLayout> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    const partitions = new Map(hostIds.map((hostId) => [hostId, this.cachedPartition(hostId)]))
    this.partitions = partitions
    this.published = this.route(partitions)
    return this.published
  }

  projectFresh(): Map<string, ProjectedLayout> {
    const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
    return this.route(new Map(hostIds.map((hostId) => [hostId, this.loadPartition(hostId, false)])))
  }

  private cachedPartition(hostId: ExecutionHostId): ProjectedPartition {
    if (this.stale === 'all') {
      const hostIds = this.deps.store()?.getWorkspaceSessionHostIds?.() ?? []
      this.stale = new Map(hostIds.map((id) => [id, 'whole' as const]))
      this.partitions.clear()
    }
    const pending = this.stale.get(hostId)
    const cached = this.partitions.get(hostId)
    if (cached && pending === undefined) {
      return cached
    }
    const next =
      (cached && pending && pending !== 'whole' ? this.reload(hostId, cached, pending) : null) ??
      this.loadPartition(hostId, true)
    this.partitions.set(hostId, next)
    this.stale.delete(hostId)
    return next
  }

  private reload(
    hostId: ExecutionHostId,
    cached: ProjectedPartition,
    written: ReadonlySet<string>
  ): ProjectedPartition | null {
    const store = this.deps.store()
    const session = store?.getWorkspaceSession?.(hostId)
    if (!cached.load || !session) {
      return null
    }
    const reloaded = reloadWorkspaces(
      hostId,
      cached.load,
      session,
      written,
      runtimeLayoutLoadContext(store, hostId)
    )
    return reloaded && cached.reloaded(reloaded.load, reloaded.keys)
  }

  /** `indexed` keeps what a later partial reload needs; one-off loads skip it. */
  private loadPartition(hostId: ExecutionHostId, indexed: boolean): ProjectedPartition {
    const store = this.deps.store()
    const session = store?.getWorkspaceSession?.(hostId)
    if (!session) {
      return new ProjectedPartition(hostId, null)
    }
    const context = runtimeLayoutLoadContext(store, hostId)
    return new ProjectedPartition(
      hostId,
      indexed
        ? loadWholePartition(hostId, session, context)
        : { loaded: loadWorkspaceLayoutWithoutReport(hostId, session, context) }
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
