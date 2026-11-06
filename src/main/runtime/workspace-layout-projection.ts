// Reproject dirty Store partitions and publish each workspace only from its owning partition.

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
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'getPtyBindingGeneration'
  | 'getLayoutEditorViews'
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

  constructor(
    private readonly hostId: ExecutionHostId,
    readonly loaded: LoadedWorkspaceLayout | null
  ) {}

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
    this.stale = 'all'
  }

  invalidate(hostId: ExecutionHostId | null): void {
    if (hostId === null || this.stale === 'all') {
      this.stale = 'all'
    } else {
      this.stale.add(hostId)
    }
  }

  /** Cache only for readers that invalidate on every write; null without a Store. */
  loaded(hostId: ExecutionHostId, keep: boolean): LoadedWorkspaceLayout | null {
    return keep ? this.cachedPartition(hostId).loaded : this.loadPartition(hostId).loaded
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
