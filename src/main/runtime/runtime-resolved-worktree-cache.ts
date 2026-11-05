import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktreeRowsJoin } from './workspaces/resolved-worktree-scan-join'
import { WORKTREE_METADATA_DOMAINS } from '../persistence/loading-store/worktree-identity-metadata'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & { expiresAt: number; inventoryRevision: number }
type CachedScanProjection = { inputs: readonly unknown[]; rows: ResolvedWorktreeRowsJoin }
type StoreWrites = { store: RuntimeStore; revision: number }
type ResolvedInFlight = {
  generation: number
  inventoryRevision: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0
  private projection: CachedScanProjection | null = null
  private storeWrites: StoreWrites | null = null

  get generation(): number {
    return this.resolvedGeneration
  }

  peek(): ResolvedCache | null {
    return this.resolved
  }

  /** Revision invalidates catalogs missing newly registered repos; TTL alone could wrongly report remote worktrees absent. */
  isFresh(inventoryRevision: number, now = Date.now()): boolean {
    return Boolean(
      this.resolved &&
      this.resolved.inventoryRevision === inventoryRevision &&
      this.resolved.expiresAt > now
    )
  }

  async getSnapshot(
    compute: () => Promise<ResolvedWorktreeSnapshot>,
    ttlMs: number,
    inventoryRevision: number
  ): Promise<ResolvedWorktreeSnapshot> {
    if (this.resolved && this.isFresh(inventoryRevision)) {
      return this.resolved
    }
    const generation = this.resolvedGeneration
    if (
      this.resolvedInFlight?.generation === generation &&
      this.resolvedInFlight.inventoryRevision === inventoryRevision
    ) {
      return this.resolvedInFlight.promise
    }
    const promise = compute()
    this.resolvedInFlight = { generation, inventoryRevision, promise }
    try {
      const result = await promise
      if (generation === this.resolvedGeneration) {
        // Start TTL on completion or slow computation publishes already-expired entries.
        this.resolved = { ...result, inventoryRevision, expiresAt: Date.now() + ttlMs }
      }
      return result
    } finally {
      if (this.resolvedInFlight?.promise === promise) {
        this.resolvedInFlight = null
      }
    }
  }

  /** Rows projected from cached scans, reused until a store write, an invalidation, or a changed scan entry; stores that cannot report writes recompute every read. */
  projectCachedScans(
    store: RuntimeStore | null,
    scanEntries: readonly unknown[],
    project: () => ResolvedWorktreeRowsJoin
  ): ResolvedWorktreeRowsJoin {
    const revision = this.storeWriteRevision(store)
    if (revision === null) {
      return project()
    }
    // Captured before projecting: a metadata migration the read itself saves must miss next time.
    const inputs = [revision, ...scanEntries]
    const held = this.projection
    if (
      held &&
      held.inputs.length === inputs.length &&
      held.inputs.every((input, index) => input === inputs[index])
    ) {
      return held.rows
    }
    const generation = this.resolvedGeneration
    const rows = project()
    if (generation === this.resolvedGeneration) {
      this.projection = { inputs, rows }
    }
    return rows
  }

  private storeWriteRevision(store: RuntimeStore | null): number | null {
    if (!store?.onStateWritten) {
      return null
    }
    if (this.storeWrites?.store !== store) {
      const writes: StoreWrites = { store, revision: 0 }
      this.storeWrites = writes
      // Rows read metadata plus repos, lineage and folder workspaces, whose saves name no domain.
      store.onStateWritten((domains) => {
        if (!domains || WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain))) {
          writes.revision += 1
        }
      })
    }
    return this.storeWrites.revision
  }

  invalidateResolved(): void {
    this.resolvedGeneration += 1
    this.resolved = null
    this.projection = null
  }
}
