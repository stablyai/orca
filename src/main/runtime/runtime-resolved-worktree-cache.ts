import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & { expiresAt: number; inventoryRevision: number }
type ResolvedInFlight = {
  generation: number
  inventoryRevision: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0

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

  invalidateResolved(): void {
    this.resolvedGeneration += 1
    this.resolved = null
  }
}
